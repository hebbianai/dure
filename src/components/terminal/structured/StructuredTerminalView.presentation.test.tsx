// @vitest-environment jsdom

import {
	act,
	fireEvent,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginTerminalDocumentResize,
	finishTerminalDocumentResize,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import {
	decodeTerminalStateRecord,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import {
	closedRecord,
	hmuxPaneBinding,
	inputReceiptRecord,
	resizeAppliedReceiptRecord,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	attachReceipt,
	bootTerminal,
	bootTerminalWithFrame,
	createWindowFocusProbe,
	deliverRecord,
	deliverRecords,
	deliverViewportFrame,
	expectSingleSemanticResize,
	flushFrames,
	installAttachMock,
	installCanvasPresentationProbe,
	mocks,
	pointerEvent,
	pressEnter,
	registerDocumentFontsRestore,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	resizeObservers,
	restoreStructuredTerminalHarness,
	selectTerminalViewportText,
	semanticResizeCalls,
	sentRecords,
	sizeStructuredHost,
	structuredObserverId,
	terminalInput,
	terminalViewport,
	visibleTerminalText,
} from "./structuredTerminalTestHarness";

const presentationScheduling = vi.hoisted(() => {
	const scheduled: Array<{ cancelled: boolean; run: () => void }> = [];
	const emptyLaneTelemetry = () => ({
		unitsRun: 0,
		msSpent: 0,
		yields: 0,
		starvationRescues: 0,
		pending: 0,
		sources: {},
	});
	return {
		scheduled,
		telemetry: {
			reveal: emptyLaneTelemetry(),
			catchup: emptyLaneTelemetry(),
			maintenance: emptyLaneTelemetry(),
		},
		schedule: vi.fn(
			(
				lane: "reveal" | "catchup",
				run: () => void,
				source: string,
				_policy: { completion: "inline" | "deferred"; burst?: boolean },
			) => {
				// Delivery admission has its own real-scheduler contract tests. This
				// suite stalls painting independently while receipts keep arriving.
				if (source === "structured-terminal-delivery") {
					run();
					return () => {};
				}
				if (lane === "reveal") {
					const frame = requestAnimationFrame(run);
					return () => cancelAnimationFrame(frame);
				}
				const unit = { cancelled: false, run };
				scheduled.push(unit);
				return () => {
					unit.cancelled = true;
				};
			},
		),
	};
});

vi.mock("@/lib/scheduling/frameBudgetScheduler", () => ({
	getFrameBudgetScheduler: () => ({
		schedule: presentationScheduling.schedule,
		getTelemetry: () => presentationScheduling.telemetry,
	}),
}));

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

beforeEach(() => {
	resetStructuredTerminalHarness();
	presentationScheduling.scheduled.length = 0;
	presentationScheduling.schedule.mockClear();
});

afterEach(() => {
	restoreStructuredTerminalHarness();
});

function installLoadingFontSet(): {
	readonly fontSet: FontFaceSet;
	readonly resolveReady: () => void;
} {
	const previous = Object.getOwnPropertyDescriptor(document, "fonts");
	const target = new EventTarget();
	let status: FontFaceSetLoadStatus = "loading";
	let resolveReady!: (fontSet: FontFaceSet) => void;
	const ready = new Promise<FontFaceSet>((resolve) => {
		resolveReady = resolve;
	});
	const fontSet = target as unknown as FontFaceSet;
	Object.defineProperties(fontSet, {
		ready: { value: ready },
		status: { get: () => status },
	});
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: fontSet,
	});
	// The shared afterEach owns the undo so a failing test still restores it.
	registerDocumentFontsRestore(() => {
		if (previous) {
			Object.defineProperty(document, "fonts", previous);
		} else {
			Reflect.deleteProperty(document, "fonts");
		}
	});
	return {
		fontSet,
		resolveReady: () => {
			status = "loaded";
			resolveReady(fontSet);
		},
	};
}

function viewportRowsIntentCalls(): Array<{
	readonly intentSeq: bigint;
	readonly rows: number;
}> {
	return mocks.send.mock.calls.flatMap(([, encoded]) => {
		const decoded = decodeTerminalStateRecord(encoded as Uint8Array);
		if (
			decoded.record.body.case !== "viewportIntent" ||
			decoded.record.body.value.intent.case !== "setViewportRows"
		) {
			return [];
		}
		return [
			{
				intentSeq: decoded.record.body.value.intentSeq,
				rows: decoded.record.body.value.intent.value.rows,
			},
		];
	});
}

describe("StructuredTerminalView resize transaction", () => {
	it("keeps the last complete pixels while synchronized terminal output is incomplete", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			stateRevision: 1n,
			throughOutputSeq: 1n,
			texts: ["complete before redraw"],
		});

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				stateRevision: 2n,
				throughOutputSeq: 2n,
				texts: ["clear outside synchronized redraw"],
				synchronizedOutput: false,
			}),
		);
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 3n,
				stateRevision: 3n,
				throughOutputSeq: 3n,
				texts: ["partial synchronized redraw"],
				synchronizedOutput: true,
			}),
		);
		await flushFrames();

		expect(visibleTerminalText(view.container)).toContain(
			"complete before redraw",
		);
		expect(visibleTerminalText(view.container)).not.toContain(
			"partial synchronized redraw",
		);
		expect(visibleTerminalText(view.container)).not.toContain(
			"clear outside synchronized redraw",
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 4n,
			stateRevision: 4n,
			throughOutputSeq: 4n,
			texts: ["complete after redraw"],
			synchronizedOutput: false,
		});

		expect(visibleTerminalText(view.container)).toContain(
			"complete after redraw",
		);
	});

	it("admits background presentation through the shared catch-up lane", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["first background frame"],
		});
		const backgroundCommitsBefore =
			workspacePerformance.snapshot().terminalPresentation.byRole.background
				.commits;

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				texts: ["newer background frame"],
			}),
		);
		await flushFrames();

		expect(visibleTerminalText(view.container)).toContain(
			"first background frame",
		);
		expect(presentationScheduling.schedule).toHaveBeenCalledWith(
			"catchup",
			expect.any(Function),
			"structured-terminal-presentation.background",
			{ completion: "deferred", burst: true },
		);

		await act(async () => {
			const unit = presentationScheduling.scheduled.shift();
			if (unit && !unit.cancelled) unit.run();
		});
		expect(visibleTerminalText(view.container)).toContain(
			"newer background frame",
		);
		expect(
			workspacePerformance.snapshot().terminalPresentation.byRole.background
				.commits - backgroundCommitsBefore,
		).toBe(1);
	});

	it.each([false, true])("reveals a background resize completion with queued output=%s", async (queuedOutput) => {
		const onRecords = installAttachMock();
		let size = { width: 800, height: 320 };
		const view = renderTerminalView({ presentationRole: "background" });
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
			columns: 80,
			texts: ["sixteen-row baseline", ...Array(15).fill("")],
			followTail: false,
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const [initialResize] = sentRecords("inputIntent");
		await deliverRecords(
			onRecords[0],
			resizeAppliedReceiptRecord(
				initialResize?.metadata.recordId ?? 0n,
				80,
				16,
			),
			viewportFrameRecord({
				projectionRevision: 2n,
				columns: 80,
				texts: ["sixteen-row baseline", ...Array(15).fill("")],
				followTail: false,
			}),
		);
		await act(async () => {
			const unit = presentationScheduling.scheduled.find(
				(candidate) => !candidate.cancelled,
			);
			if (unit) unit.run();
		});
		await flushFrames();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 3n,
				columns: 80,
				texts: ["steady background baseline", ...Array(15).fill("")],
				followTail: false,
			}),
		);
		expect(presentationScheduling.schedule).toHaveBeenLastCalledWith(
			"catchup",
			expect.any(Function),
			"structured-terminal-presentation.background",
			{ completion: "deferred", burst: true },
		);
		await act(async () => {
			const unit = presentationScheduling.scheduled.find(
				(candidate) => !candidate.cancelled,
			);
			if (unit) unit.run();
		});
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain(
			"steady background baseline",
		);
		expect(presentation.rect().height).toBe(320);
		mocks.send.mockClear();
		presentationScheduling.scheduled.length = 0;
		presentationScheduling.schedule.mockClear();

		if (queuedOutput) {
			await deliverRecord(onRecords[0], viewportFrameRecord({
				projectionRevision: 4n, columns: 80,
				texts: ["unpainted output", ...Array(15).fill("")], followTail: false,
			}));
		}
		size = { width: 800, height: 440 };
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expectSingleSemanticResize(80, 22);
		expect(presentation.rect().height).toBe(320);
		const [resize] = sentRecords("inputIntent");

		await deliverRecords(
			onRecords[0],
			resizeAppliedReceiptRecord(resize?.metadata.recordId ?? 0n, 80, 22),
			viewportFrameRecord({
				projectionRevision: queuedOutput ? 5n : 4n,
				columns: 80,
				texts: ["twenty-two-row completion", ...Array(21).fill("")],
				followTail: false,
			}),
		);
		await flushFrames();

		expect(visibleTerminalText(view.container)).toContain(
			"twenty-two-row completion",
		);
		expect(presentation.rect().height).toBe(440);
		expect(
			presentationScheduling.scheduled.filter((unit) => !unit.cancelled),
		).toHaveLength(0);
	});

	it("cancels an unadmitted background presentation when the attachment retires", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["first background frame"],
		});
		expect(
			presentationScheduling.scheduled.filter((unit) => !unit.cancelled),
		).toHaveLength(0);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				texts: ["retired background frame"],
			}),
		);
		await act(async () => Promise.resolve());
		const pending =
			presentationScheduling.scheduled[
				presentationScheduling.scheduled.length - 1
			];
		expect(pending?.cancelled).toBe(false);

		view.unmount();
		expect(pending?.cancelled).toBe(true);
		expect(
			presentationScheduling.scheduled.filter((unit) => !unit.cancelled),
		).toHaveLength(0);
		await waitFor(() => expect(mocks.detach).toHaveBeenCalledOnce());
	});

	it("keeps reading while only the latest background frame waits for paint", async () => {
		const onRecords = installAttachMock();
		renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		const observerId = structuredObserverId(1);
		await waitFor(() =>
			expect(mocks.pullWaiters.get(observerId)).toHaveLength(1),
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["first background frame"],
		});
		await waitFor(() =>
			expect(mocks.pullWaiters.get(observerId)).toHaveLength(1),
		);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				texts: ["queued background frame"],
			}),
		);
		await act(async () => Promise.resolve());

		expect(presentationScheduling.scheduled).toHaveLength(1);
		expect(mocks.pullWaiters.get(observerId)).toHaveLength(1);
		await deliverRecord(onRecords[0], viewportFrameRecord({
			projectionRevision: 3n, texts: ["latest queued background frame"],
		}));
		expect(presentationScheduling.scheduled).toHaveLength(1);
		expect(mocks.pullWaiters.get(observerId)).toHaveLength(1);

		await act(async () => {
			const unit = presentationScheduling.scheduled.shift();
			if (unit && !unit.cancelled) unit.run();
		});
		await waitFor(() =>
			expect(mocks.pullWaiters.get(observerId)).toHaveLength(1),
		);
	});

	it("releases a promoted pane's exact input successor before the old frame callback", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		const observerId = structuredObserverId(1);
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			stateRevision: 1n,
			throughOutputSeq: 1n,
			texts: ["baseline"],
		});

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				stateRevision: 2n,
				throughOutputSeq: 2n,
				texts: ["queued background"],
			}),
		);
		expect(
			presentationScheduling.scheduled.filter((unit) => !unit.cancelled),
		).toHaveLength(1);
		expect(mocks.pullWaiters.get(observerId)).toHaveLength(1);

		view.rerender(
			<StructuredTerminalView
				sessionId="session-a"
				surfaceId="pane-a"
				binding={hmuxPaneBinding("session-a")}
				presentationRole="foreground"
			/>,
		);
		mocks.send.mockClear();
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		const inputRecordId =
			sentRecords("inputIntent")[0]?.metadata.recordId ?? 0n;
		const viewportStyle = vi.spyOn(
			terminalViewport(view.container).style,
			"setProperty",
		);
		const presentationStyle = view.getByTestId(
			"structured-terminal-presentation",
		).style;
		const presentationStyleSet = vi.spyOn(presentationStyle, "setProperty");
		const presentationStyleRemove = vi.spyOn(
			presentationStyle,
			"removeProperty",
		);

		await deliverRecords(
			onRecords[0],
			inputReceiptRecord(inputRecordId, undefined, 2n),
			viewportFrameRecord({
				projectionRevision: 3n,
				stateRevision: 3n,
				throughOutputSeq: 3n,
				texts: ["exact input echo"],
				inputOutputTiming: {
					inputBaselineOutputSequence: 2n,
					firstOutputSequence: 3n,
					inputToOutputMicros: 2_316n,
					outputToProjectionStartMicros: 909n,
					inputRecordId,
				},
			}),
		);
		await act(async () => Promise.resolve());

		expect(visibleTerminalText(view.container)).toContain("exact input echo");
		expect(visibleTerminalText(view.container)).not.toContain(
			"queued background",
		);

		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain("exact input echo");
		expect(terminalInputLatency.snapshot()).toMatchObject({
			inFlightCount: 0,
			samples: [{ outcome: "complete", source: "keydown" }],
		});
		expect(viewportStyle).not.toHaveBeenCalled();
		expect({
			removals: presentationStyleRemove.mock.calls.length,
			writes: presentationStyleSet.mock.calls.length,
		}).toEqual({ removals: 0, writes: 0 });
		viewportStyle.mockRestore();
		presentationStyleSet.mockRestore();
		presentationStyleRemove.mockRestore();
	});

	it("advances canonical input fences without repainting an unchanged background frame", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
			appliedIntentSeq: 0n,
			texts: ["stable background frame"],
		});
		const backgroundCommitsBefore =
			workspacePerformance.snapshot().terminalPresentation.byRole.background
				.commits;
		presentationScheduling.scheduled.length = 0;
		presentationScheduling.schedule.mockClear();
		mocks.send.mockClear();

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 8n,
				stateRevision: 9n,
				throughOutputSeq: 12n,
				appliedIntentSeq: 0n,
				texts: ["stable background frame"],
			}),
		);
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		const inputRecordId = sentRecords("inputIntent")[0]?.metadata.recordId ?? 0n;

		expect(sentRecords("inputIntent")[0]?.record).toMatchObject({
			stateRevision: 9n,
			throughOutputSeq: 12n,
		});
		expect(presentationScheduling.schedule.mock.calls.filter(
			([, , source]) => source !== "structured-terminal-delivery",
		)).toHaveLength(0);
		expect(
			presentationScheduling.scheduled.filter((unit) => !unit.cancelled),
		).toHaveLength(0);
		expect(
			workspacePerformance.snapshot().terminalPresentation.byRole.background
				.commits - backgroundCommitsBefore,
		).toBe(0);
		expect(visibleTerminalText(view.container)).toContain(
			"stable background frame",
		);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 9n,
				stateRevision: 9n,
				throughOutputSeq: 13n,
				appliedIntentSeq: 0n,
				texts: ["stable background frame"],
				inputOutputTiming: {
					inputBaselineOutputSequence: 12n,
					firstOutputSequence: 13n,
					inputToOutputMicros: 300n,
					outputToProjectionStartMicros: 100n,
					inputRecordId,
				},
			}),
		);
		expect(presentationScheduling.schedule).toHaveBeenCalledWith(
			"catchup",
			expect.any(Function),
			"structured-terminal-presentation.background",
			{ completion: "deferred", burst: true },
		);
		await act(async () => {
			const unit = presentationScheduling.scheduled.shift();
			if (unit && !unit.cancelled) unit.run();
		});
		expect(
			workspacePerformance.snapshot().terminalPresentation.byRole.background
				.commits - backgroundCommitsBefore,
		).toBe(1);
		presentationScheduling.schedule.mockClear();

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 10n,
				stateRevision: 10n,
				throughOutputSeq: 14n,
				texts: ["changed background frame"],
			}),
		);
		expect(presentationScheduling.schedule).toHaveBeenCalledWith(
			"catchup",
			expect.any(Function),
			"structured-terminal-presentation.background",
			{ completion: "deferred", burst: false },
		);
		await act(async () => {
			const unit = presentationScheduling.scheduled.shift();
			if (unit && !unit.cancelled) unit.run();
		});
		expect(visibleTerminalText(view.container)).toContain(
			"changed background frame",
		);
		expect(
			workspacePerformance.snapshot().terminalPresentation.byRole.background
				.commits - backgroundCommitsBefore,
		).toBe(2);
	});

	it("promotes a queued background frame when the pane becomes foreground", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["first background frame"],
		});
		const roleCommitsBefore =
			workspacePerformance.snapshot().terminalPresentation.byRole;
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				texts: ["queued background frame"],
			}),
		);

		view.rerender(
			<StructuredTerminalView
				sessionId="session-a"
				surfaceId="pane-a"
				binding={hmuxPaneBinding("session-a")}
				presentationRole="foreground"
			/>,
		);
		await flushFrames();

		expect(presentationScheduling.scheduled[0]?.cancelled).toBe(true);
		expect(presentationScheduling.schedule).toHaveBeenCalledWith(
			"reveal",
			expect.any(Function),
			"structured-terminal-presentation.foreground",
			{ completion: "inline" },
		);
		expect(visibleTerminalText(view.container)).toContain(
			"queued background frame",
		);
		const roleCommitsAfter =
			workspacePerformance.snapshot().terminalPresentation.byRole;
		expect(
			roleCommitsAfter.foreground.commits -
				roleCommitsBefore.foreground.commits,
		).toBe(1);
		expect(
			roleCommitsAfter.background.commits -
				roleCommitsBefore.background.commits,
		).toBe(0);
	});

	it("does not count or trigger a paint for a role-only rerender", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ presentationRole: "background" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["stable role frame"],
		});
		const commitsBefore =
			workspacePerformance.snapshot().terminalPresentation.total.commits;

		view.rerender(
			<StructuredTerminalView
				sessionId="session-a"
				surfaceId="pane-a"
				binding={hmuxPaneBinding("session-a")}
				presentationRole="foreground"
			/>,
		);
		await flushFrames();

		expect(visibleTerminalText(view.container)).toContain("stable role frame");
		expect(
			workspacePerformance.snapshot().terminalPresentation.total.commits -
				commitsBefore,
		).toBe(0);
	});

	it("exposes the current Host viewport as native selectable DOM rows", async () => {
		const { view } = await bootTerminalWithFrame({
			texts: ["native selectable text"],
			splitTextIntoGraphemes: true,
		});

		const row = view.container.querySelector(".term-row");
		expect(row?.textContent?.trimEnd()).toBe("native selectable text");
	});

	it("invalidates cached metrics when fonts resolve before the first frame", async () => {
		const { fontSet, resolveReady } = installLoadingFontSet();
		mocks.attach.mockResolvedValue(attachReceipt());
		renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());

		resolveReady();
		await act(async () => {
			await fontSet.ready;
			await Promise.resolve();
		});

		expect(mocks.invalidateMetrics).toHaveBeenCalledOnce();
	});

	it("repaints and republishes idle geometry when the selected font becomes ready", async () => {
		const { fontSet, resolveReady } = installLoadingFontSet();
		let resolvedFont = false;
		mocks.measure.mockImplementation((width: number, height: number) => {
			const cellWidth = resolvedFont ? 20 : 10;
			return {
				cellWidth,
				rowHeight: 20,
				columns: Math.max(1, Math.floor(width / cellWidth)),
				rows: Math.max(1, Math.floor(height / 20)),
				asciiRunCapability: "fixed_cell_advance" as const,
			};
		});
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		installCanvasPresentationProbe(view.container, () => ({
			width: 800,
			height: 400,
		}));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["font before change", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(semanticResizeCalls()[0]).toMatchObject({ columns: 80, rows: 20 });
		mocks.send.mockClear();

		resolvedFont = true;
		resolveReady();
		await act(async () => {
			await fontSet.ready;
			await Promise.resolve();
		});
		await flushFrames();
		expect(mocks.invalidateMetrics).toHaveBeenCalledOnce();
		await act(async () => {
			fontSet.dispatchEvent(new Event("loadingdone"));
			await Promise.resolve();
		});
		await flushFrames();
		expect(mocks.invalidateMetrics).toHaveBeenCalledOnce();
		expectSingleSemanticResize(40, 20);
		const [resize] = sentRecords("inputIntent");
		expect(resize).toBeDefined();
		await deliverRecords(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				columns: 80,
				texts: ["font output on old geometry", ...Array(19).fill("")],
			}),
			viewportFrameRecord({
				projectionRevision: 3n,
				columns: 40,
				texts: ["font frame before receipt", ...Array(19).fill("")],
			}),
		);
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain("font before change");
		expect(visibleTerminalText(view.container)).not.toContain(
			"font frame before receipt",
		);
		await deliverRecord(
			onRecords[0],
			resizeAppliedReceiptRecord(resize?.metadata.recordId ?? 0n, 40, 20),
		);
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain("font before change");
		expect(visibleTerminalText(view.container)).not.toContain(
			"font frame before receipt",
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 4n,
			columns: 40,
			texts: ["font after change", ...Array(19).fill("")],
		});
		expect(visibleTerminalText(view.container)).toContain("font after change");
	});

	it("exposes a received complete projection while hidden paint is suspended", async () => {
		const { probe, qaSurface } = createWindowFocusProbe();
		const onRecords = installAttachMock();
		const view = renderTerminalView({ windowFocusProbe: probe });
		sizeStructuredHost(view, 800, 400);
		installCanvasPresentationProbe(view.container, () => ({
			width: 800,
			height: 400,
		}));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await waitFor(() => expect(probe.connect).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
			texts: ["painted baseline", ...Array(19).fill("")],
		});
		await waitFor(() => expect(probe.onPresented).toHaveBeenCalledOnce());
		const paintedCount = vi.mocked(probe.onPresented).mock.calls.length;
		const marker = "HMUX_WINDOW_QA_0123456789AB_B_0002";

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 8n,
				stateRevision: 10n,
				throughOutputSeq: 12n,
				texts: [marker, ...Array(19).fill("")],
			}),
		);

		expect(qaSurface().markerCounts()).toEqual({});
		expect(qaSurface().projectionMarkerCounts?.()).toEqual({ [marker]: 1 });
		expect(probe.onPresented).toHaveBeenCalledTimes(paintedCount);
		expect(visibleTerminalText(view.container)).toContain("painted baseline");

		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain(marker);
	});

	it("keeps native draining independent of one coalesced paint", async () => {
		const { onRecords, view } = await bootTerminal();
		await flushFrames();
		await deliverViewportFrame(onRecords[0], { texts: ["revision 1"] });
		expect(visibleTerminalText(view.container)).toBe("revision 1");
		mocks.send.mockClear();
		const input = terminalInput(view);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				texts: ["revision 2"],
			}),
		);
		pressEnter(input);
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		expect(sentRecords("inputIntent")[0]?.record).toMatchObject({
			stateRevision: 2n,
			throughOutputSeq: 2n,
		});
		expect(visibleTerminalText(view.container)).toBe("revision 1");
		await waitFor(() =>
			expect(mocks.pullWaiters.get(structuredObserverId(1))).toHaveLength(1),
		);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 25n,
				texts: ["revision 25"],
			}),
		);
		pressEnter(input);
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(2));
		expect(sentRecords("inputIntent")[1]?.record).toMatchObject({
			stateRevision: 25n,
			throughOutputSeq: 25n,
		});
		expect(visibleTerminalText(view.container)).toBe("revision 1");

		await flushFrames();
		expect(visibleTerminalText(view.container)).toBe("revision 25");
	});

	it("keeps the last complete source frame visible until one current return frame swaps", async () => {
		mocks.desktopId = "desktop-a";
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		const host = sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(mocks.bindLargeViewReturnSource).toHaveBeenCalledOnce(),
		);
		expect(mocks.largeViewReturnPrepare?.("return-cold")).toBe(false);
		expect(mocks.largeViewReturnConceal).not.toHaveBeenCalled();
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: ["source proposal", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(mocks.bindLargeViewReturnSource).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-a",
				sessionId: "session-a",
				sourcePaneOwnerId: "desktop-a:pane-a",
			}),
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			columns: 120,
			texts: ["large canonical frame", ...Array(19).fill("")],
		});
		const viewport = terminalViewport(view.container);
		const replaceChildren = viewport.replaceChildren.bind(viewport);
		const replacements: string[] = [];
		vi.spyOn(viewport, "replaceChildren").mockImplementation((...nodes) => {
			replaceChildren(...nodes);
			replacements.push(
				visibleTerminalText(view.container).split("\n")[0] ?? "",
			);
		});
		mocks.send.mockClear();

		mocks.windowFocused = false;
		expect(mocks.largeViewReturnPrepare?.("return-1")).toBe(true);
		expect(mocks.largeViewReturnConceal).toHaveBeenCalledOnce();
		expect(mocks.largeViewReturnComplete).not.toHaveBeenCalled();
		expect(semanticResizeCalls()).toHaveLength(0);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 3n,
			columns: 120,
			texts: ["output before detach", ...Array(19).fill("")],
		});
		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"large canonical frame",
		);
		expect(viewport.childElementCount).toBeGreaterThan(0);
		expect(replacements).toEqual([]);
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
		expect(mocks.largeViewReturnPrepare?.("return-2")).toBe(true);
		expect(mocks.largeViewReturnConceal).toHaveBeenCalledOnce();
		mocks.windowFocused = true;
		act(() => {
			for (const listener of mocks.windowFocusListeners) listener(true);
		});
		expect(mocks.largeViewReturnComplete).not.toHaveBeenCalled();
		mocks.largeViewReturnRetired?.("return-2");
		await waitFor(() =>
			expect(viewportRowsIntentCalls()).toContainEqual({
				intentSeq: 1n,
				rows: 20,
			}),
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 4n,
			appliedIntentSeq: 1n,
			columns: 80,
			texts: ["source after detach", ...Array(19).fill("")],
		});

		expect(mocks.largeViewReturnComplete).toHaveBeenCalledOnce();
		expect(mocks.largeViewReturnComplete).toHaveBeenCalledWith("return-2");
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"source after detach",
		);
		expect(replacements).toEqual(["source after detach"]);
		expect(semanticResizeCalls()).toHaveLength(0);
	});

	it("reveals the returned source when a sibling keeps the canonical grid wider", async () => {
		mocks.desktopId = "desktop-a";
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		const host = sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: Array(20).fill("source"),
		});
		await waitFor(() =>
			expect(mocks.bindLargeViewReturnSource).toHaveBeenCalledOnce(),
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			columns: 120,
			texts: Array(20).fill("large surface"),
		});
		mocks.windowFocused = false;
		expect(mocks.largeViewReturnPrepare?.("return-sibling")).toBe(true);
		mocks.windowFocused = true;
		act(() => {
			for (const listener of mocks.windowFocusListeners) listener(true);
		});
		expect(mocks.largeViewReturnComplete).not.toHaveBeenCalled();
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);

		mocks.largeViewReturnRetired?.("return-sibling");
		await waitFor(() =>
			expect(viewportRowsIntentCalls()).toContainEqual({
				intentSeq: 1n,
				rows: 20,
			}),
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 3n,
			appliedIntentSeq: 1n,
			columns: 100,
			texts: Array(20).fill("remaining sibling canonical"),
		});
		expect(mocks.largeViewReturnComplete).toHaveBeenCalledWith(
			"return-sibling",
		);
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
	});

	it("does not complete an old return target from a replacement attachment epoch", async () => {
		mocks.desktopId = "desktop-a";
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const replacementSeed = viewportFrameRecord({
					terminalEpoch: "terminal-b",
					projectionRevision: 1n,
					columns: 80,
					texts: Array(20).fill("replacement source"),
				});
				request.onRecord(replacementSeed.buffer as ArrayBuffer);
			}
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const view = renderTerminalView();
		const host = sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			terminalEpoch: "terminal-a",
			projectionRevision: 1n,
			columns: 80,
			texts: Array(20).fill("source"),
		});
		await waitFor(() =>
			expect(mocks.bindLargeViewReturnSource).toHaveBeenCalledOnce(),
		);
		await deliverViewportFrame(onRecords[0], {
			terminalEpoch: "terminal-a",
			projectionRevision: 2n,
			columns: 120,
			texts: Array(20).fill("large"),
		});
		mocks.windowFocused = false;
		expect(mocks.largeViewReturnPrepare?.("return-old")).toBe(true);
		mocks.largeViewReturnRetired?.("return-old");
		await waitFor(() =>
			expect(viewportRowsIntentCalls()).toContainEqual({
				intentSeq: 1n,
				rows: 20,
			}),
		);

		await deliverRecord(
			onRecords[0],
			closedRecord("hmux_stream_desynchronized", "replace attachment", "never"),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(mocks.largeViewReturnDispose).not.toHaveBeenCalled();
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
		mocks.windowFocused = true;
		act(() => {
			for (const listener of mocks.windowFocusListeners) listener(true);
		});

		await deliverViewportFrame(onRecords[0], {
			terminalEpoch: "terminal-a",
			projectionRevision: 3n,
			columns: 80,
			texts: Array(20).fill("retired source"),
		});

		expect(mocks.largeViewReturnComplete).not.toHaveBeenCalled();
		expect(mocks.bindLargeViewReturnSource).toHaveBeenCalledOnce();
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);

		await deliverViewportFrame(onRecords[1], {
			terminalEpoch: "terminal-b",
			projectionRevision: 2n,
			appliedIntentSeq: 1n,
			columns: 80,
			texts: Array(20).fill("replacement aligned"),
		});

		expect(mocks.largeViewReturnComplete).toHaveBeenCalledWith("return-old");
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
	});

	it("retargets an active return when local geometry changes after prepare", async () => {
		mocks.desktopId = "desktop-a";
		const onRecords = installAttachMock();
		let size = { width: 800, height: 400 };
		const view = renderTerminalView();
		const host = sizeStructuredHost(
			view,
			() => size.width,
			() => size.height,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: Array(20).fill("source"),
		});
		await waitFor(() =>
			expect(mocks.bindLargeViewReturnSource).toHaveBeenCalledOnce(),
		);
		expect(mocks.largeViewReturnPrepare?.("return-grid")).toBe(true);
		mocks.send.mockClear();
		mocks.largeViewReturnRetired?.("return-grid");
		await waitFor(() =>
			expect(viewportRowsIntentCalls()).toContainEqual({
				intentSeq: 1n,
				rows: 20,
			}),
		);

		size = { width: 1_000, height: 600 };
		act(() => resizeObservers[0]?.callback([], {} as ResizeObserver));
		await flushFrames();
		expectSingleSemanticResize(100, 30);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			appliedIntentSeq: 1n,
			columns: 80,
			texts: Array(20).fill("old grid"),
		});
		expect(mocks.largeViewReturnComplete).not.toHaveBeenCalled();
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 3n,
			appliedIntentSeq: 2n,
			columns: 100,
			texts: Array(30).fill("new grid"),
		});
		expect(mocks.largeViewReturnComplete).toHaveBeenCalledWith("return-grid");
		expect(host.classList.contains("terminal-canonical-resize-settling")).toBe(
			false,
		);
	});

	it("keeps held IME and selection semantics on the painted presentation", async () => {
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
			cursorColumn: 1,
			cursorRow: 19,
			texts: ["painted frame", ...Array(19).fill("")],
			followTail: true,
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();

		beginTerminalDocumentResize(document, "pane-a");
		size = { width: 1_200, height: 600 };
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
			const retained = viewportFrameRecord({
				projectionRevision: 2n,
				columns: 80,
				cursorColumn: 7,
				cursorRow: 0,
				texts: ["unpainted frame", ...Array(19).fill("")],
				followTail: true,
			});
			onRecords[0]?.(retained.buffer as ArrayBuffer);
		});
		await flushFrames();

		try {
			const input = terminalInput(view);
			input.focus();
			mocks.send.mockClear();
			fireEvent.compositionStart(input, { data: "ㅎ" });
			const composition = view.getByTestId("structured-terminal-composition");
			expect(input.style.left).toBe("10px");
			expect(input.style.top).toBe("380px");
			expect(composition.style.left).toBe("10px");
			expect(composition.style.top).toBe("380px");
			expect(input.parentElement?.getAttribute("data-testid")).toBe(
				"structured-terminal-presentation",
			);
			expect(composition.parentElement).toBe(input.parentElement);
			const layer = input.parentElement as HTMLDivElement;
			expect(layer.style.bottom).toBe("0px");
			expect(layer.style.width).toBe("800px");
			expect(layer.style.height).toBe("400px");
			expect(
				Number.parseFloat(layer.style.bottom || "0") +
					(size.height - Number.parseFloat(layer.style.height)) +
					Number.parseFloat(composition.style.top),
			).toBe(580);

			const canvas = terminalViewport(view.container);
			expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
				"painted frame",
			);
			fireEvent.pointerDown(canvas, {
				pointerId: 19,
				buttons: 1,
				clientX: 10,
				clientY: 590,
			});
			fireEvent.pointerMove(canvas, {
				pointerId: 19,
				buttons: 1,
				clientX: 60,
				clientY: 590,
			});
			expect(selectTerminalViewportText(canvas).trim()).toContain(
				"painted frame",
			);
			fireEvent.pointerUp(canvas, {
				pointerId: 19,
				buttons: 0,
				clientX: 60,
				clientY: 590,
			});
			await flushFrames();
			expect(mocks.writeClipboard).toHaveBeenCalledWith(
				expect.stringContaining("painted frame"),
			);
		} finally {
			finishTerminalDocumentResize(document, "blur");
		}
	});

	it("keeps a DPR backing store pixel-locked and tail-anchored through a sash grow", async () => {
		const onRecords = installAttachMock();
		vi.stubGlobal("devicePixelRatio", 2);
		let size = { width: 800.25, height: 400.25 };
		const view = renderTerminalView();
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
			columns: 80,
			texts: ["tail before grow", ...Array(19).fill("")],
			followTail: true,
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(mocks.measure).toHaveBeenLastCalledWith(
			size.width,
			size.height,
			expect.any(String),
			expect.any(Number),
			expect.any(Number),
		);
		mocks.send.mockClear();

		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);
		sash.dispatchEvent(pointerEvent("pointerdown"));
		size = { width: 1_200.75, height: 600.5 };
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
			const intermediate = viewportFrameRecord({
				projectionRevision: 2n,
				columns: 80,
				texts: ["latest output during grow", ...Array(19).fill("")],
				followTail: true,
			});
			onRecords[0]?.(intermediate.buffer as ArrayBuffer);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		expect(presentation.rect()).toMatchObject({
			width: 800.25,
			height: 400.25,
			top: 200.25,
		});

		document.body.dispatchEvent(pointerEvent("pointerup"));
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expectSingleSemanticResize(120, 30);
		const [resize] = sentRecords("inputIntent");
		expect(resize).toBeDefined();
		await act(async () => {
			onRecords[0]?.(
				resizeAppliedReceiptRecord(resize?.metadata.recordId ?? 0n, 140, 30)
					.buffer as ArrayBuffer,
			);
			const finalFrame = viewportFrameRecord({
				projectionRevision: 3n,
				columns: 140,
				texts: ["tail after grow", ...Array(29).fill("")],
				followTail: true,
			});
			onRecords[0]?.(finalFrame.buffer as ArrayBuffer);
		});
		await flushFrames();
		expect(mocks.measure).toHaveBeenLastCalledWith(
			size.width,
			size.height,
			expect.any(String),
			expect.any(Number),
			expect.any(Number),
		);
		expect(presentation.rect()).toMatchObject(size);
		expect(presentation.layer.style.width).toBe("");
		expect(presentation.layer.style.height).toBe("");
		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"tail after grow",
		);
		sash.remove();
	});

	it.each([
		{ label: "follow-tail", followTail: true, expectedTop: -200.25 },
		{ label: "anchored", followTail: false, expectedTop: 0 },
	])(
		"clips a held $label presentation without scaling through a native shrink",
		async ({ followTail, expectedTop }) => {
			const onRecords = installAttachMock();
			vi.stubGlobal("devicePixelRatio", 1);
			let size = { width: 1_200.75, height: 600.5 };
			const view = renderTerminalView();
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
				columns: 120,
				texts: ["before shrink", ...Array(29).fill("")],
				followTail,
			});
			await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
			mocks.send.mockClear();

			beginTerminalDocumentResize(document, "pane-a");
			size = { width: 800.25, height: 400.25 };
			await act(async () => {
				resizeObservers[0]?.callback([], {} as ResizeObserver);
			});
			await flushFrames();
			expect(semanticResizeCalls()).toHaveLength(0);
			expect(presentation.rect()).toMatchObject({
				width: 1_200.75,
				height: 600.5,
				top: expectedTop,
			});

			finishTerminalDocumentResize(document, "blur");
			await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
			const [resize] = sentRecords("inputIntent");
			expect(resize).toBeDefined();
			await deliverRecords(
				onRecords[0],
				resizeAppliedReceiptRecord(resize?.metadata.recordId ?? 0n, 120, 30),
				viewportFrameRecord({
					projectionRevision: 2n,
					columns: 120,
					texts: ["after shrink", ...Array(19).fill("")],
					followTail,
				}),
			);
			await flushFrames();
			expect(mocks.measure).toHaveBeenLastCalledWith(
				size.width,
				size.height,
				expect.any(String),
				expect.any(Number),
				expect.any(Number),
			);
			expect(presentation.rect()).toMatchObject(size);
		},
	);
});
