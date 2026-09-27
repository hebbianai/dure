// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resizeAppliedReceiptRecord,
	type ViewportFrameRecordOptions,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	deliverRecords,
	deliverViewportFrame,
	flushFrames,
	installAttachMock,
	mocks,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	resizeObservers,
	restoreStructuredTerminalHarness,
	semanticResizeCalls,
	sentRecords,
	sizeStructuredHost,
	terminalElement,
	terminalInput,
	terminalViewport,
} from "./structuredTerminalTestHarness";

const phone = vi.hoisted(() => ({ columns: undefined as number | undefined }));
vi.mock("@/lib/hub/useHubTerminalWidth", () => ({
	useHubTerminalWidth: () => phone.columns,
}));
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

let revision = 1n;
beforeEach(() => {
	resetStructuredTerminalHarness();
	phone.columns = undefined;
	revision = 1n;
});
afterEach(restoreStructuredTerminalHarness);

async function settleWidth(
	onRecord: ((record: ArrayBuffer) => void) | undefined,
	columns: number,
	rows: number,
	frame: ViewportFrameRecordOptions,
) {
	const resize = sentRecords("inputIntent").find(
		({ record }) =>
			record.body.case === "inputIntent" &&
			record.body.value.intent.case === "resize",
	);
	expect(resize).toBeDefined();
	await deliverRecords(
		onRecord,
		resizeAppliedReceiptRecord(resize!.metadata.recordId, columns, rows),
		viewportFrameRecord({
			...frame,
			texts: Array.from({ length: rows }, (_, i) => frame.texts?.[i] ?? ""),
			projectionRevision: ++revision,
		}),
	);
	await flushFrames();
}

async function narrowTerminal(followTail = true) {
	const records = installAttachMock();
	const view = renderTerminalView();
	sizeStructuredHost(view, 380, 400);
	await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
	await deliverViewportFrame(records[0], {
		columns: 38,
		texts: ["retained text"],
		followTail,
	});
	await settleWidth(records[0], 38, 20, {
		columns: 38,
		texts: ["retained text"],
		followTail,
	});
	mocks.send.mockClear();
	return { view, records };
}

async function changePhone(
	view: ReturnType<typeof renderTerminalView>,
	columns: number | undefined,
) {
	phone.columns = columns;
	view.rerender(terminalElement("session-a"));
	await flushFrames();
}

describe("phone width on a narrower desktop terminal", () => {
	it("lifts, rotates and restores the same writer without replacing its attachment", async () => {
		const { view, records } = await narrowTerminal();
		for (const [phoneWidth, expected] of [
			[53, 53],
			[90, 90],
			[30, 38],
			[undefined, 38],
		] as const) {
			await changePhone(view, phoneWidth);
			if (phoneWidth === undefined) {
				expect(semanticResizeCalls()).toHaveLength(0);
				break;
			}
			expect(semanticResizeCalls()).toMatchObject([
				{ columns: expected, rows: 20 },
			]);
			await settleWidth(records[0], expected, 20, {
				columns: expected,
				texts: ["retained text"],
			});
			mocks.send.mockClear();
		}
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
	});

	it("updates a retained hidden history writer from its last measured grid, then restores it", async () => {
		const { view, records } = await narrowTerminal(false);
		mocks.workspaceActive = false;
		view.rerender(terminalElement("session-a"));
		await flushFrames();
		await act(async () => {
			for (const observer of resizeObservers)
				observer.callback(
					[{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry],
					{} as ResizeObserver,
				);
		});
		await changePhone(view, 53);
		expect(semanticResizeCalls()).toMatchObject([{ columns: 53, rows: 20 }]);
		await settleWidth(records[0], 53, 20, {
			columns: 53,
			texts: ["retained text"],
			followTail: false,
		});
		mocks.send.mockClear();
		await changePhone(view, undefined);
		expect(semanticResizeCalls()).toMatchObject([{ columns: 38, rows: 20 }]);
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
	});

	it("makes all wider columns reachable with local horizontal wheel and leaves vertical history scrolling intact", async () => {
		const { view, records } = await narrowTerminal();
		await changePhone(view, 53);
		await settleWidth(records[0], 53, 20, {
			columns: 53,
			texts: [`${"x".repeat(52)}Z`],
		});
		const viewport = view.getByTestId("structured-terminal-presentation");
		expect((viewport.firstElementChild as HTMLElement).style.width).toBe(
			"530px",
		);
		mocks.send.mockClear();
		fireEvent.wheel(terminalViewport(view.container), {
			deltaX: 200,
			deltaY: 1,
		});
		expect(viewport.scrollLeft).toBe(150);
		expect(mocks.send).not.toHaveBeenCalled();
		fireEvent.wheel(terminalViewport(view.container), {
			deltaY: -4,
			deltaMode: 1,
			shiftKey: true,
		});
		expect(viewport.scrollLeft).toBe(110);
		fireEvent.wheel(terminalViewport(view.container), { deltaY: -120 });
		await flushFrames();
		expect(sentRecords("viewportIntent")).toHaveLength(1);
		await changePhone(view, undefined);
		await settleWidth(records[0], 38, 20, {
			columns: 38,
			texts: ["retained text"],
		});
		expect(viewport.scrollLeft).toBe(0);
		expect((viewport.firstElementChild as HTMLElement).style.width).toBe(
			"380px",
		);
	});

	it("reveals the cursor while typing but preserves an explicit horizontal history position", async () => {
		const { view, records } = await narrowTerminal();
		await changePhone(view, 53);
		await settleWidth(records[0], 53, 20, {
			columns: 53,
			texts: ["retained text"],
			cursorColumn: 52,
		});
		const viewport = view.getByTestId("structured-terminal-presentation");
		const input = terminalInput(view);
		await act(async () => input.focus());
		fireEvent.input(input, { target: { value: "a" } });
		await deliverViewportFrame(records[0], {
			columns: 53,
			texts: Array(20).fill("retained text"),
			cursorColumn: 52,
			projectionRevision: 10n,
		});
		expect(viewport.scrollLeft).toBe(150);
		fireEvent.wheel(terminalViewport(view.container), { deltaX: -100 });
		fireEvent.keyDown(input, { key: "Meta", metaKey: true });
		fireEvent.keyDown(input, { key: "c", metaKey: true });
		await deliverViewportFrame(records[0], {
			columns: 53,
			texts: Array(20).fill("retained text"),
			cursorColumn: 52,
			projectionRevision: 11n,
		});
		expect(viewport.scrollLeft).toBe(50);
	});
});
