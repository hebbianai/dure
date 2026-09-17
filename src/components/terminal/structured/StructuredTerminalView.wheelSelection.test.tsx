// @vitest-environment jsdom

import {
	act,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	BufferId,
	MouseTrackingMode,
	PointerKind,
	RowTermination,
} from "@/contracts/terminalStateProtocol";
import {
	decodeTerminalStateRecord,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import {
	clipboardEventRecord,
	viewportFrameRecord,
	wheelFailureReceiptRecord,
	wheelReceiptRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	attachReceipt,
	bootTerminal,
	bootTerminalWithFrame,
	deliverRecord,
	deliverRecords,
	deliverViewportFrame,
	flushFrames,
	frames,
	installAttachMock,
	mocks,
	registerStructuredTerminalView,
	renderTerminalBesideOutsideButton,
	renderTerminalView,
	resetStructuredTerminalHarness,
	resizeObservers,
	restoreStructuredTerminalHarness,
	selectTerminalViewportText,
	semanticResizeCalls,
	sentRecords,
	sizeStructuredHost,
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

beforeEach(() => {
	resetStructuredTerminalHarness();
});

afterEach(() => {
	restoreStructuredTerminalHarness();
});

function structuredOutboundObservation(encoded: Uint8Array): {
	readonly kind: string;
	readonly intentSeq: bigint | null;
} {
	const decoded = decodeTerminalStateRecord(encoded);
	const body = decoded.record.body as unknown as {
		readonly case?: string;
		readonly value?: { readonly intentSeq?: bigint };
	};
	return {
		kind: body.case ?? "missing",
		intentSeq:
			typeof body.value?.intentSeq === "bigint" ? body.value.intentSeq : null,
	};
}

function pinTerminalViewportRect(
	viewport: HTMLDivElement,
	width = 800,
	height = 40,
): void {
	vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		right: width,
		bottom: height,
		width,
		height,
		toJSON: () => ({}),
	});
}

function selectAllTerminalViewportRows(viewport: HTMLDivElement): Selection {
	const rows = [...viewport.querySelectorAll<HTMLElement>(".term-row")];
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (!first || !last) throw new Error("structured terminal rows are missing");
	const range = document.createRange();
	range.setStart(first, 0);
	range.setEnd(last, last.childNodes.length);
	const selection = window.getSelection();
	if (!selection) throw new Error("browser selection is unavailable");
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

describe("StructuredTerminalView resize transaction", () => {
	it("keeps return to bottom available during new output and waits for the Host to reach the tail", async () => {
		const texts = Array.from({ length: 20 }, (_, index) => `history ${index}`);
		const { onRecords, view } = await bootTerminalWithFrame({ texts, followTail: false, rowsFromTail: 40n, hasMoreAfter: true });
		const button = () => view.queryByRole("button", { name: t("terminal.chrome.scrollToBottom") });
		expect(button()).not.toBeNull();
		// Anchored output advances while the Host can no longer give an exact
		// distance. Content below the viewport still authorizes returning to it.
		await deliverRecord(onRecords[0], viewportFrameRecord({ texts: ["output while reading history", ...texts.slice(1)], projectionRevision: 2n, throughOutputSeq: 2n, followTail: false, rowsFromTail: undefined, hasMoreAfter: true }));
		await waitFor(() => expect(visibleTerminalText(view.container)).toContain("output while reading history"));
		const jump = await view.findByRole("button", { name: t("terminal.chrome.scrollToBottom") });
		mocks.send.mockClear();
		fireEvent.click(jump);
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		const [intent] = sentRecords("viewportIntent");
		expect(intent?.record.body).toMatchObject({ case: "viewportIntent", value: { intent: { case: "followTail" } } });
		expect(sentRecords("inputIntent")).toHaveLength(0);
		expect(button()).not.toBeNull();
		await deliverRecord(onRecords[0], viewportFrameRecord({ texts, projectionRevision: 3n, followTail: true, rowsFromTail: 0n }));
		await waitFor(() => expect(button()).toBeNull());
	});

	it("silently reattaches when a wheel send races observer retirement", async () => {
		const onRecords = installAttachMock((attach) => {
			if (attach > 1) return new Promise(() => {});
			return { selectedCapabilities: ["terminal_viewport_wheel_v1"] };
		});
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["retained scroll frame", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();
		mocks.send.mockRejectedValueOnce(
			new Error("structured terminal connection is not attached"),
		);

		fireEvent.wheel(terminalViewport(view.container), { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		expect(visibleTerminalText(view.container)).toContain(
			"retained scroll frame",
		);
		expect(
			view.queryByText(/structured terminal connection is not attached/),
		).toBeNull();
		expect(terminalInput(view).disabled).toBe(true);
	});

	it("does not create a terminal selection from a single focus click", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const canvas = terminalViewport(view.container);

		fireEvent.pointerDown(canvas, { pointerId: 19, clientX: 10, clientY: 10 });
		fireEvent.pointerUp(canvas, { pointerId: 19, clientX: 10, clientY: 10 });

		expect(window.getSelection()?.isCollapsed).toBe(true);
		expect(mocks.writeClipboard).not.toHaveBeenCalled();
	});

	it("preserves the input caret when clicking an already focused terminal", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const viewport = terminalViewport(view.container);
		const input = terminalInput(view);
		act(() => input.focus());
		// jsdom has no textarea shadow editor. Represent its collapsed native
		// caret explicitly so the gesture cannot clear an unrelated selection.
		const caret = document.createRange();
		caret.selectNodeContents(input);
		caret.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(caret);

		fireEvent.pointerDown(viewport, { pointerId: 73, button: 0, buttons: 1 });
		fireEvent.mouseDown(viewport, { button: 0, buttons: 1, detail: 1 });
		fireEvent.pointerUp(viewport, { pointerId: 73, button: 0, buttons: 0 });

		expect(document.activeElement).toBe(input);
		expect(selection?.rangeCount).toBe(1);
		expect(selection?.isCollapsed).toBe(true);
		expect(mocks.writeClipboard).not.toHaveBeenCalled();

		input.value = "pending helper text";
		input.setSelectionRange(0, 0);
		selectTerminalViewportText(viewport);
		fireEvent.pointerDown(viewport, { pointerId: 74, button: 0, buttons: 1 });
		fireEvent.mouseDown(viewport, { button: 0, buttons: 1, detail: 1 });
		fireEvent.pointerUp(viewport, { pointerId: 74, button: 0, buttons: 0 });
		expect(document.activeElement).toBe(input);
		expect(input.selectionStart).toBe(input.value.length);
		expect(input.selectionEnd).toBe(input.value.length);
	});

	it.each(["jitter", "released", "blur", "right-click"])(
		"does not select or copy text during %s instead of a deliberate drag",
		async (scenario) => {
			const { onRecords, view } = await bootTerminal();
			await deliverRecord(onRecords[0], viewportFrameRecord({ texts: ["accidental terminal selection"] }));
			const viewport = terminalViewport(view.container);
			pinTerminalViewportRect(viewport);
			window.getSelection()?.removeAllRanges();
			const rightClick = scenario === "right-click";
			fireEvent.pointerDown(viewport, {
				pointerId: 71, button: rightClick ? 2 : 0, buttons: rightClick ? 2 : 1,
				clientX: 10, clientY: 10,
			});
			if (scenario === "blur") fireEvent(window, new Event("blur"));
			fireEvent.pointerMove(window, {
				pointerId: 71, buttons: scenario === "released" ? 0 : rightClick ? 2 : 1,
				clientX: scenario === "jitter" ? 13 : 60, clientY: 10,
			});
			expect(window.getSelection()?.isCollapsed).toBe(true);
			fireEvent.pointerUp(viewport, { pointerId: 71, button: rightClick ? 2 : 0, buttons: 0, clientX: scenario === "jitter" ? 13 : 60, clientY: 10 });
			await flushFrames();
			expect(mocks.writeClipboard).not.toHaveBeenCalled();
		},
	);

	it("keeps a single-click gesture out of native selection while preserving multi-click defaults", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord({ texts: ["select a word"] }));
		const viewport = terminalViewport(view.container);
		fireEvent.pointerDown(viewport, { pointerId: 72, button: 0, buttons: 1, clientX: 10, clientY: 10 });
		expect(fireEvent.mouseDown(viewport, { button: 0, buttons: 1, detail: 1 })).toBe(false);
		fireEvent.pointerUp(viewport, { pointerId: 72, button: 0, buttons: 0, clientX: 10, clientY: 10 });
		fireEvent.pointerDown(viewport, { pointerId: 72, button: 0, buttons: 1, clientX: 10, clientY: 10 });
		expect(fireEvent.mouseDown(viewport, { button: 0, buttons: 1, detail: 2 })).toBe(true);
		selectTerminalViewportText(viewport);
		fireEvent.pointerUp(viewport, { pointerId: 72, button: 0, buttons: 0, clientX: 10, clientY: 10 });
		expect(window.getSelection()?.toString()).toBe("select a word");
		await waitFor(() => expect(mocks.writeClipboard).toHaveBeenCalledWith("select a word"));
	});

	it("copies a real drag selection when copy-on-select is enabled", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: ["selected terminal text"] }),
		);
		const canvas = terminalViewport(view.container);

		fireEvent.pointerDown(canvas, { pointerId: 19, buttons: 1, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(canvas, { pointerId: 19, buttons: 1, clientX: 60, clientY: 10 });
		expect(selectTerminalViewportText(canvas)).toBe("selected terminal text");
		fireEvent.pointerUp(canvas, { pointerId: 19, clientX: 60, clientY: 10 });
		await flushFrames();

		await waitFor(() =>
			expect(mocks.writeClipboard).toHaveBeenCalledWith(
				"selected terminal text",
			),
		);
		await waitFor(() =>
			expect(mocks.showToast).toHaveBeenCalledWith("클립보드에 복사됨"),
		);
	});

	it("maps selection and reported clicks to the canonical viewport rows", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 160);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["aligned terminal text", ...Array(7).fill("")],
			cursorRow: 4,
			mouseTracking: MouseTrackingMode.ANY,
		});
		const viewport = terminalViewport(view.container);
		pinTerminalViewportRect(viewport, 800, 160);
		expect(
			viewport.querySelector<HTMLElement>(".terminal-viewport-row")?.style
				.marginTop,
		).toBe("");

		fireEvent.pointerDown(viewport, {
			pointerId: 31,
			button: 0,
			buttons: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerMove(viewport, {
			pointerId: 31,
			buttons: 1,
			clientX: 80,
			clientY: 10,
		});
		expect(selectTerminalViewportText(viewport)).toBe("aligned terminal text");
		fireEvent.pointerUp(viewport, {
			pointerId: 31,
			button: 0,
			buttons: 0,
			clientX: 80,
			clientY: 10,
		});

		mocks.send.mockClear();
		fireEvent.pointerDown(viewport, {
			pointerId: 32,
			button: 0,
			buttons: 1,
			clientX: 20,
			clientY: 130,
		});
		fireEvent.pointerUp(viewport, {
			pointerId: 32,
			button: 0,
			buttons: 0,
			clientX: 20,
			clientY: 130,
		});
		const pointerRecords = () =>
			sentRecords("inputIntent").filter(({ record }) =>
				record.body.case === "inputIntent"
					? record.body.value.intent.case === "pointer"
					: false,
			);
		await waitFor(() => expect(pointerRecords()).toHaveLength(2));
		const pointerRows = pointerRecords().map(({ record }) => {
			if (
				record.body.case !== "inputIntent" ||
				record.body.value.intent.case !== "pointer"
			) {
				throw new Error("expected pointer input intent");
			}
			return record.body.value.intent.value.row;
		});
		expect(pointerRows).toEqual([6, 6]);
	});

	it("extends a drag selection through Host-owned viewport autoscroll", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				texts: ["first", "second"],
				logicalLineIds: [1n, 2n],
				followTail: false,
				hasMoreAfter: true,
			}),
		);
		const viewport = terminalViewport(view.container);
		pinTerminalViewportRect(viewport);
		mocks.send.mockClear();

		fireEvent.pointerDown(viewport, {
			pointerId: 24,
			button: 0,
			buttons: 1,
			clientX: 0,
			clientY: 5,
		});
		fireEvent.pointerMove(window, {
			pointerId: 24,
			buttons: 1,
			clientX: 50,
			clientY: 48,
		});
		await flushFrames();

		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		const [scroll] = sentRecords("viewportIntent");
		if (scroll?.record.body.case !== "viewportIntent") {
			throw new Error("expected viewport intent");
		}
		expect(scroll.record.body.value.intent).toMatchObject({
			case: "scrollRows",
			value: { rows: -1 },
		});

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				appliedIntentSeq: 1n,
				texts: ["second", "third"],
				logicalLineIds: [2n, 3n],
				followTail: false,
				hasMoreAfter: true,
			}),
		);
		await flushFrames();
		fireEvent.pointerUp(window, {
			pointerId: 24,
			button: 0,
			buttons: 0,
			clientX: 50,
			clientY: 48,
		});
		await flushFrames();

		await waitFor(() =>
			expect(mocks.writeClipboard).toHaveBeenCalledWith(
				"first\nsecond\nthird",
			),
		);
		expect(sentRecords("viewportIntent")).toHaveLength(1);
	});

	it("cancels drag-edge autoscroll before a canceled pointer can mutate the viewport", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				texts: ["first", "second"],
				logicalLineIds: [1n, 2n],
				followTail: false,
				hasMoreAfter: true,
			}),
		);
		const viewport = terminalViewport(view.container);
		pinTerminalViewportRect(viewport);
		mocks.send.mockClear();

		fireEvent.pointerDown(viewport, {
			pointerId: 25,
			buttons: 1,
			clientX: 0,
			clientY: 5,
		});
		fireEvent.pointerMove(window, {
			pointerId: 25,
			buttons: 1,
			clientX: 50,
			clientY: 48,
		});
		fireEvent.pointerCancel(window, { pointerId: 25 });
		await flushFrames();

		expect(sentRecords("viewportIntent")).toHaveLength(0);
		expect(mocks.writeClipboard).not.toHaveBeenCalled();
	});

	it("cancels scheduled drag-edge autoscroll when the surface unmounts", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				texts: ["first", "second"],
				logicalLineIds: [1n, 2n],
				followTail: false,
				hasMoreAfter: true,
			}),
		);
		const viewport = terminalViewport(view.container);
		pinTerminalViewportRect(viewport);
		mocks.send.mockClear();

		fireEvent.pointerDown(viewport, {
			pointerId: 26,
			buttons: 1,
			clientX: 0,
			clientY: 5,
		});
		fireEvent.pointerMove(window, {
			pointerId: 26,
			buttons: 1,
			clientX: 50,
			clientY: 48,
		});
		view.unmount();
		await flushFrames();

		expect(sentRecords("viewportIntent")).toHaveLength(0);
	});

	it("captures soft-wrapped copy-on-select before a streaming frame can collapse it", async () => {
		const { onRecords, view } = await bootTerminalWithFrame({
			texts: ["soft-", "wrapped"],
			logicalLineIds: [77n, 77n],
			rowTerminations: [RowTermination.SOFT_WRAP, RowTermination.HARD_BREAK],
		});
		const viewport = terminalViewport(view.container);

		fireEvent.pointerDown(viewport, {
			pointerId: 21,
			buttons: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerMove(viewport, {
			pointerId: 21,
			buttons: 1,
			clientX: 60,
			clientY: 30,
		});
		const selection = selectAllTerminalViewportRows(viewport);
		const selectionToString = vi
			.spyOn(selection, "toString")
			.mockReturnValue("soft-\nwrapped");
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				damageBaseProjectionRevision: 1n,
				changedRowIndices: [1],
				texts: ["soft-", "streamed"],
				logicalLineIds: [77n, 77n],
				rowTerminations: [RowTermination.SOFT_WRAP, RowTermination.HARD_BREAK],
			}),
		);
		fireEvent.pointerUp(viewport, {
			pointerId: 21,
			clientX: 60,
			clientY: 30,
		});
		await flushFrames();
		selectionToString.mockRestore();

		await waitFor(() =>
			expect(mocks.writeClipboard).toHaveBeenCalledWith("soft-wrapped"),
		);
	});

	it("intercepts native copy and joins only contiguous soft-wrapped logical rows", async () => {
		const { view } = await bootTerminalWithFrame({
			texts: ["soft-", "wrapped", "next"],
			logicalLineIds: [77n, 77n, 78n],
			rowTerminations: [
				RowTermination.SOFT_WRAP,
				RowTermination.HARD_BREAK,
				RowTermination.HARD_BREAK,
			],
		});
		const viewport = terminalViewport(view.container);
		selectAllTerminalViewportRows(viewport);
		const setData = vi.fn();

		fireEvent.copy(viewport, { clipboardData: { setData } });

		expect(setData).toHaveBeenCalledWith("text/plain", "soft-wrapped\nnext");
	});

	it("uses a plain drag for selection while preserving reported mouse clicks", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				mouseTracking: MouseTrackingMode.ANY,
				texts: ["selected terminal text"],
			}),
		);
		const canvas = terminalViewport(view.container);
		expect(canvas.hasAttribute("data-selectable")).toBe(true);
		mocks.send.mockClear();

		fireEvent.pointerDown(canvas, {
			pointerId: 19,
			button: 0,
			buttons: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerMove(canvas, {
			pointerId: 19,
			buttons: 1,
			clientX: 60,
			clientY: 10,
		});
		expect(selectTerminalViewportText(canvas)).toBe("selected terminal text");
		fireEvent.pointerUp(canvas, {
			pointerId: 19,
			button: 0,
			buttons: 0,
			clientX: 60,
			clientY: 10,
		});
		await flushFrames();

		await waitFor(() =>
			expect(mocks.writeClipboard).toHaveBeenCalledWith(
				"selected terminal text",
			),
		);
		expect(
			sentRecords("inputIntent").filter(({ record }) =>
				record.body.case === "inputIntent"
					? record.body.value.intent.case === "pointer"
					: false,
			),
		).toHaveLength(0);

		mocks.send.mockClear();
		fireEvent.pointerDown(canvas, {
			pointerId: 20,
			button: 0,
			buttons: 1,
			clientX: 20,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 20,
			button: 0,
			buttons: 0,
			clientX: 20,
			clientY: 10,
		});
		await waitFor(() =>
			expect(
				sentRecords("inputIntent").filter(({ record }) =>
					record.body.case === "inputIntent"
						? record.body.value.intent.case === "pointer"
						: false,
				),
			).toHaveLength(2),
		);
	});

	it.each([{ button: 1, buttons: 4 }, { button: 2, buttons: 2 }])("preserves the full reported click for non-selection button $button", async ({ button, buttons }) => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord({ mouseTracking: MouseTrackingMode.ANY, texts: ["terminal mouse input"] }));
		const viewport = terminalViewport(view.container);
		mocks.send.mockClear();
		fireEvent.pointerDown(viewport, { pointerId: 73, button, buttons, clientX: 20, clientY: 10 });
		fireEvent.pointerUp(viewport, { pointerId: 73, button, buttons: 0, clientX: 20, clientY: 10 });
		await waitFor(() => {
			const pointers = sentRecords("inputIntent").flatMap(({ record }) => record.body.case === "inputIntent" && record.body.value.intent.case === "pointer" ? [record.body.value.intent.value.kind] : []);
			expect(pointers).toEqual([PointerKind.DOWN, PointerKind.UP]);
		});
		expect(mocks.writeClipboard).not.toHaveBeenCalled();
	});

	it("uses Shift-drag for local selection while the terminal reports mouse input", async () => {
		const { onRecords, view } = await bootTerminal();
		await flushFrames();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				mouseTracking: MouseTrackingMode.ANY,
				texts: ["selected terminal text"],
			}),
		);
		const canvas = terminalViewport(view.container);
		mocks.send.mockClear();

		fireEvent.pointerDown(canvas, {
			pointerId: 19,
			buttons: 1,
			clientX: 10,
			clientY: 10,
			shiftKey: true,
		});
		fireEvent.pointerMove(canvas, {
			pointerId: 19,
			buttons: 1,
			clientX: 60,
			clientY: 10,
			shiftKey: true,
		});
		expect(selectTerminalViewportText(canvas)).toBe("selected terminal text");
		fireEvent.pointerUp(canvas, {
			pointerId: 19,
			clientX: 60,
			clientY: 10,
			shiftKey: true,
		});
		await flushFrames();

		await waitFor(() =>
			expect(mocks.writeClipboard).toHaveBeenCalledWith(
				"selected terminal text",
			),
		);
		const pointerIntents = sentRecords("inputIntent").filter(({ record }) => {
			if (record.body.case !== "inputIntent") return false;
			return record.body.value.intent.case === "pointer";
		});
		expect(pointerIntents).toHaveLength(0);
	});

	it("applies each ordered structured clipboard event exactly once", async () => {
		const { onRecords, view } = await bootTerminal();
		await flushFrames();
		await deliverViewportFrame(onRecords[0], { throughEventId: 7n });
		terminalInput(view).focus();
		const event = clipboardEventRecord(8n, "copied from TUI");

		await deliverRecords(onRecords[0], event, event);

		await waitFor(() =>
			expect(mocks.writeClipboard).toHaveBeenCalledWith("copied from TUI"),
		);
		expect(mocks.writeClipboard).toHaveBeenCalledTimes(1);
	});

	it("accepts the exact wheel receipt before the complete paint frame", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_viewport_wheel_v1"],
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: ["tail"] });
		mocks.send.mockClear();
		const canvas = terminalViewport(view.container);

		fireEvent.wheel(canvas, { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		const [sent] = sentRecords("viewportIntent");
		expect(sent).toBeDefined();
		await deliverRecord(
			onRecords[0],
			wheelReceiptRecord(sent.metadata.recordId, 1n),
		);

		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(visibleTerminalText(view.container)).toBe("tail");
		expect(view.queryByText(/terminal wheel/)).toBeNull();
	});

	for (const outcome of ["refused", "failed"] as const) {
		it(`keeps a correlated wheel ${outcome} visible when the same batch paints a complete frame`, async () => {
			const onRecords = installAttachMock(() => ({
				selectedCapabilities: ["terminal_viewport_wheel_v1"],
			}));
			const view = renderTerminalView();
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverRecord(
				onRecords[0],
				viewportFrameRecord({ texts: ["before wheel failure"] }),
			);
			await flushFrames();
			mocks.send.mockClear();

			fireEvent.wheel(terminalViewport(view.container), { deltaY: -120 });
			await flushFrames();
			await waitFor(() =>
				expect(sentRecords("viewportIntent")).toHaveLength(1),
			);
			const [sent] = sentRecords("viewportIntent");
			expect(sent).toBeDefined();

			await deliverRecords(
				onRecords[0],
				wheelFailureReceiptRecord(sent.metadata.recordId, outcome),
				viewportFrameRecord({
					projectionRevision: 2n,
					throughOutputSeq: 1n,
					texts: ["complete frame after wheel failure"],
				}),
			);
			await flushFrames();

			expect(
				view.getByText(new RegExp(`terminal wheel ${outcome}`)),
			).toBeTruthy();
			expect(visibleTerminalText(view.container)).toBe(
				"complete frame after wheel failure",
			);
			expect(mocks.attach).toHaveBeenCalledOnce();
			expect(mocks.detach).not.toHaveBeenCalled();
		});
	}

	it("keeps resize and wheel receipt bookkeeping constant through an unacknowledged burst", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_viewport_wheel_v1"],
		}));
		let width = 800;
		const view = renderTerminalView();
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: ["tail", ...Array(19).fill("")] }),
		);
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();

		const nativeMapSet = Map.prototype.set;
		let pendingReceiptMapWrites = 0;
		const mapSet = vi.spyOn(Map.prototype, "set").mockImplementation(function (
			this: Map<unknown, unknown>,
			key: unknown,
			value: unknown,
		) {
			if (
				typeof key === "bigint" &&
				typeof value === "object" &&
				value !== null &&
				"kind" in value &&
				((value as { kind?: unknown }).kind === "resize" ||
					(value as { kind?: unknown }).kind === "wheel")
			) {
				pendingReceiptMapWrites += 1;
			}
			return Reflect.apply(nativeMapSet, this, [key, value]);
		});
		try {
			for (let index = 1; index <= 16; index += 1) {
				width = 800 + index * 10;
				await act(async () => {
					resizeObservers[0]?.callback([], {} as ResizeObserver);
				});
				await flushFrames();
			}
			const viewport = terminalViewport(view.container);
			for (let index = 0; index < 16; index += 1) {
				fireEvent.wheel(viewport, { deltaY: -20 });
				await flushFrames();
			}
		} finally {
			mapSet.mockRestore();
		}

		expect(semanticResizeCalls()).toHaveLength(16);
		expect(sentRecords("viewportIntent")).toHaveLength(16);
		expect(pendingReceiptMapWrites).toBe(0);
	});

	it("uses base row scroll when the attached Host did not select wheel", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: [
				"terminal_state_binary_v1",
				"terminal_viewport_projection_v1",
			],
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: ["tail"] });
		mocks.send.mockClear();

		fireEvent.wheel(terminalViewport(view.container), { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		const [outbound] = sentRecords("viewportIntent");
		expect(outbound?.metadata.protocolMinor).toBe(4);
		expect(outbound?.record.schemaMinor).toBe(4);
		if (outbound?.record.body.case !== "viewportIntent") {
			throw new Error("expected viewport intent");
		}
		expect(outbound.record.body.value.intent).toMatchObject({
			case: "scrollRows",
			value: { rows: 6 },
		});

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			appliedIntentSeq: 1n,
			texts: ["history"],
			followTail: false,
		});

		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(visibleTerminalText(view.container)).toBe("history");
		expect(view.queryByText(/terminal wheel/)).toBeNull();
	});

	it("keeps hover wheel in presentation without activating or focusing the pane", async () => {
		mocks.attach.mockResolvedValue(attachReceipt());
		const activatePane = vi.fn();
		const view = render(
			<div onWheel={activatePane}>
				<button type="button">outside input</button>
				{terminalElement("session-a")}
			</div>,
		);
		const outside = view.getByRole("button", { name: "outside input" });
		outside.focus();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		const canvas = terminalViewport(view.container);
		expect(canvas).not.toBeNull();

		fireEvent.wheel(canvas, { deltaY: -120 });

		expect(activatePane).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(outside);
	});

	it("folds one animation frame of wheel deltas before assigning one viewport sequence", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_viewport_wheel_v1"],
		}));
		const { view, outside } = renderTerminalBesideOutsideButton();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await deliverViewportFrame(onRecords[0], { texts: ["tail"] });
		mocks.send.mockClear();
		const canvas = terminalViewport(view.container);

		await act(async () => {
			for (let index = 0; index < 24; index += 1) {
				fireEvent.wheel(canvas, { deltaY: index < 20 ? -20 : 20 });
			}
			await Promise.resolve();
		});

		expect(sentRecords("viewportIntent")).toHaveLength(0);
		expect(document.activeElement).toBe(outside);

		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		const [outbound] = sentRecords("viewportIntent");
		expect(outbound?.record.body.case).toBe("viewportIntent");
		if (outbound?.record.body.case !== "viewportIntent") return;
		expect(outbound.record.body.value.intentSeq).toBe(1n);
		expect(outbound.record.body.value.intent).toMatchObject({
			case: "wheel",
			value: {
				kind: PointerKind.WHEEL,
				wheelDeltaX: 0,
				wheelDeltaY: -16,
			},
		});
		expect(document.activeElement).toBe(outside);

		mocks.send.mockClear();
		for (let index = 0; index < 4; index += 1) {
			fireEvent.wheel(canvas, { deltaY: -2 });
		}
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		const [fineGrained] = sentRecords("viewportIntent");
		if (
			fineGrained?.record.body.case !== "viewportIntent" ||
			fineGrained.record.body.value.intent.case !== "wheel"
		) {
			throw new Error("expected folded wheel intent");
		}
		expect(fineGrained.record.body.value.intent.value.wheelDeltaY).toBe(-1);

		mocks.send.mockClear();
		fireEvent.wheel(canvas, { deltaY: -2 });
		fireEvent.wheel(canvas, { deltaY: 2 });
		await flushFrames();
		expect(sentRecords("viewportIntent")).toHaveLength(0);
	});

	it("serializes large-view wheel IPC admission in viewport sequence order", async () => {
		mocks.desktopId = "large-view-desktop";
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_viewport_wheel_v1"],
		}));
		const view = renderTerminalView({ surfaceId: "session-a" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await deliverViewportFrame(onRecords[0], { texts: ["large view history"] });

		let resolveFirstSend!: (receipt: string) => void;
		const firstSend = new Promise<string>((resolve) => {
			resolveFirstSend = resolve;
		});
		mocks.send.mockClear();
		mocks.send
			.mockImplementationOnce(async () => firstSend)
			.mockResolvedValue("record-2");
		const canvas = terminalViewport(view.container);

		fireEvent.wheel(canvas, { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
		fireEvent.wheel(canvas, { deltaY: 120 });
		await flushFrames();

		expect(mocks.send).toHaveBeenCalledOnce();
		expect(
			mocks.send.mock.calls.map(([, encoded]) =>
				structuredOutboundObservation(encoded as Uint8Array),
			),
		).toEqual([{ kind: "viewportIntent", intentSeq: 1n }]);

		await act(async () => resolveFirstSend("record-1"));
		await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
		expect(
			mocks.send.mock.calls.map(([, encoded]) =>
				structuredOutboundObservation(encoded as Uint8Array),
			),
		).toEqual([
			{ kind: "viewportIntent", intentSeq: 1n },
			{ kind: "viewportIntent", intentSeq: 2n },
		]);
	});

	it("cancels a pending wheel batch when its attachment retires", async () => {
		const onRecords = installAttachMock((attach) => ({
			terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b",
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: ["attachment A"] }),
		);
		mocks.send.mockClear();
		const canvas = terminalViewport(view.container);

		fireEvent.wheel(canvas, { deltaY: -20 });
		expect(sentRecords("viewportIntent")).toHaveLength(0);
		const pendingWheelFrame = [...frames.keys()][0];
		expect(pendingWheelFrame).toBeDefined();
		view.rerender(terminalElement("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(frames.has(pendingWheelFrame ?? -1)).toBe(false);
		await flushFrames();

		expect(sentRecords("viewportIntent")).toHaveLength(0);
	});

	it("replaces the viewport from one wheel intent without focus or browser paging", async () => {
		const onRecords = installAttachMock();
		const { view, outside } = renderTerminalBesideOutsideButton();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				texts: ["tail"],
				mouseTracking: MouseTrackingMode.ANY,
			}),
		);
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toBe("tail"),
		);
		mocks.send.mockClear();
		const canvas = terminalViewport(view.container);

		fireEvent.wheel(canvas, { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
		const outbound = structuredOutboundObservation(
			mocks.send.mock.calls[0]?.[1] as Uint8Array,
		);
		expect(outbound).toEqual({ kind: "viewportIntent", intentSeq: 1n });
		await act(async () => {
			const history = viewportFrameRecord({
				projectionRevision: 2n,
				stateRevision: 1n,
				throughOutputSeq: 1n,
				appliedIntentSeq: 1n,
				texts: ["history"],
				followTail: false,
				hasMoreBefore: true,
			});
			onRecords[0]?.(history.buffer as ArrayBuffer);
		});
		await flushFrames();

		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toBe("history"),
		);
		expect(document.activeElement).toBe(outside);
	});

	it("sends one Host-routed wheel with bounded DOM delta units from an alternate-screen mouse surface", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_viewport_wheel_v1"],
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["Claude", ""],
			activeBuffer: BufferId.ALTERNATE,
			mouseTracking: MouseTrackingMode.ANY,
		});
		mocks.send.mockClear();
		const canvas = terminalViewport(view.container);
		const sentWheelDeltaY = () => {
			const [outbound] = sentRecords("viewportIntent");
			if (outbound?.record.body.case !== "viewportIntent") {
				throw new Error("expected viewport intent");
			}
			const intent = outbound.record.body.value.intent as {
				readonly case: string;
				readonly value?: {
					readonly kind: PointerKind;
					readonly wheelDeltaX: number;
					readonly wheelDeltaY: number;
				};
			};
			expect(intent).toMatchObject({
				case: "wheel",
				value: { kind: PointerKind.WHEEL, wheelDeltaX: 0 },
			});
			return intent.value?.wheelDeltaY;
		};

		fireEvent.wheel(canvas, { deltaY: -120, clientX: 20, clientY: 20 });
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		expect(sentRecords("inputIntent")).toHaveLength(0);
		expect(sentWheelDeltaY()).toBe(-6);

		mocks.send.mockClear();
		fireEvent.wheel(canvas, {
			deltaY: 3,
			deltaMode: WheelEvent.DOM_DELTA_LINE,
			clientX: 20,
			clientY: 20,
		});
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		expect(sentRecords("inputIntent")).toHaveLength(0);
		expect(sentWheelDeltaY()).toBe(3);

		mocks.send.mockClear();
		fireEvent.wheel(canvas, {
			deltaY: -1,
			deltaMode: WheelEvent.DOM_DELTA_PAGE,
			clientX: 20,
			clientY: 20,
		});
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		expect(sentRecords("inputIntent")).toHaveLength(0);
		expect(sentWheelDeltaY()).toBe(-2);

		mocks.send.mockClear();
		fireEvent.wheel(canvas, { deltaY: -2_000, clientX: 20, clientY: 20 });
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		expect(sentRecords("inputIntent")).toHaveLength(0);
		expect(sentWheelDeltaY()).toBe(-64);
	});

	it("forwards Shift-wheel through the same Host-owned route", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_viewport_wheel_v1"],
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["alternate screen"],
			activeBuffer: BufferId.ALTERNATE,
			mouseTracking: MouseTrackingMode.ANY,
		});
		mocks.send.mockClear();
		const canvas = terminalViewport(view.container);

		fireEvent.wheel(canvas, { deltaY: -120, shiftKey: true });
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));

		expect(sentRecords("inputIntent")).toHaveLength(0);
		const [outbound] = sentRecords("viewportIntent");
		if (
			outbound?.record.body.case !== "viewportIntent" ||
			outbound.record.body.value.intent.case !== "wheel"
		) {
			throw new Error("expected Host-routed wheel intent");
		}
		expect(outbound.record.body.value.intent.value.modifiers).toBe(1);
	});

	it("replaces a skipped complete frame after hover wheel intents without client recovery", async () => {
		let resolveFirstSend!: () => void;
		const onRecords = installAttachMock();
		const { view, outside } = renderTerminalBesideOutsideButton();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 1n,
				appliedIntentSeq: 0n,
				stateRevision: 1n,
				throughOutputSeq: 0n,
				texts: ["old top", "old bottom"],
				hasMoreBefore: true,
			}),
		);
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toBe("old top\nold bottom"),
		);
		mocks.send.mockClear();
		mocks.send
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						resolveFirstSend = () => resolve("record-1");
					}),
			)
			.mockResolvedValue("record-2");
		const canvas = terminalViewport(view.container);

		fireEvent.wheel(canvas, { deltaY: -120 });
		fireEvent.wheel(canvas, { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
		fireEvent.wheel(canvas, { deltaY: -120 });
		await flushFrames();
		expect(mocks.send).toHaveBeenCalledOnce();
		await act(async () => resolveFirstSend());
		await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 4n,
				appliedIntentSeq: 2n,
				stateRevision: 4n,
				throughOutputSeq: 4n,
				texts: ["new top", "new bottom"],
				hasMoreBefore: true,
			}),
		);
		await flushFrames();

		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toBe("new top\nnew bottom"),
		);
		const outbound = (mocks.send.mock.calls as [string, Uint8Array][]).map(
			([, encoded]) => structuredOutboundObservation(encoded),
		);
		expect
			.soft(outbound.map(({ kind }) => kind))
			.toEqual(["viewportIntent", "viewportIntent"]);
		expect.soft(outbound.map(({ intentSeq }) => intentSeq)).toEqual([1n, 2n]);
		expect
			.soft(outbound.map(({ kind }) => kind))
			.not.toContain("historyRequest");
		expect(document.activeElement).toBe(outside);
	});
});
