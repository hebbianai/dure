// @vitest-environment jsdom

import {
	act,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { cloneElement, type ComponentProps, Profiler } from "react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import {
	terminalInputLatency,
} from "@/lib/terminal/interaction/terminalInputLatency";
import { t } from "@/lib/i18n";
import { remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { capturePaneQuickCommandTarget } from "@/lib/workspace/pane/paneQuickCommandTarget";
import {
	beginPaneContentFocus,
	currentPaneContentFocus,
} from "@/lib/workspace/pane/paneContentFocusHandoff";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import {
	closedRecord,
	hmuxPaneBinding,
	inputReceiptRecord,
	inputRefusedReceiptRecord,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	bootTerminal,
	bootTerminalWithFrame,
	createWindowFocusProbe,
	deliverRecord,
	deliverViewportFrame,
	flushFrames,
	installAttachMock,
	installCanvasPresentationProbe,
	mocks,
	pressEnter,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	restoreStructuredTerminalHarness,
	sentInputIntents,
	sentRecords,
	sentTextPayloads,
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
	vi.unstubAllEnvs();
	restoreStructuredTerminalHarness();
});

/** Clean up at timeout too; a late finally must not restore a successor's spies. */
function registerTestCleanup(cleanup: () => void): () => void {
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		cleanup();
	};
	onTestFinished(dispose);
	return dispose;
}

describe("saved Quick Command pane input", () => {
	it("uses the mounted pane paste path and waits for its receipt before Enter", async () => {
		const { onRecords } = await bootTerminalWithFrame();
		await waitFor(() => expect(capturePaneQuickCommandTarget("pane-a")).toBeTypeOf("function"));
		const target = capturePaneQuickCommandTarget("pane-a");
		const done = target?.({ id: "status", label: "Status", text: "git status", appendEnter: true });
		const [paste] = sentInputIntents("paste");
		if (paste?.record.body.case !== "inputIntent" || paste.record.body.value.intent.case !== "paste") throw new Error("paste missing");
		expect(new TextDecoder().decode(paste.record.body.value.intent.value.utf8)).toBe("git status");
		expect(sentInputIntents("key")).toHaveLength(0);
		await deliverRecord(onRecords[0], inputReceiptRecord(paste.metadata.recordId));
		const [enter] = sentInputIntents("key");
		if (enter?.record.body.case !== "inputIntent" || enter.record.body.value.intent.case !== "key") throw new Error("Enter missing");
		expect(enter.record.body.value.intent.value.key).toBe("Enter");
		await deliverRecord(onRecords[0], inputReceiptRecord(enter.metadata.recordId));
		await done;
	});
	it("leaves input-only text unsubmitted and retires captured targets with the view", async () => {
		const { onRecords, view } = await bootTerminalWithFrame();
		const target = capturePaneQuickCommandTarget("pane-a");
		expect(target).toBeTypeOf("function");
		const command = { id: "review", label: "Review", text: "/goal Review", appendEnter: false };
		const done = target?.(command);
		const [paste] = sentInputIntents("paste");
		if (!paste) throw new Error("paste missing");
		await deliverRecord(onRecords[0], inputReceiptRecord(paste.metadata.recordId));
		await done;
		expect(sentInputIntents("key")).toHaveLength(0);
		view.unmount();
		await expect(target?.(command)).rejects.toThrow("unavailable");
	});
});

function structuredPaneFocusHarness() {
	let onWillFocus: ((event: { preventDefault(): void }) => void) | undefined;
	const groupFocusTarget = document.createElement("button");
	groupFocusTarget.textContent = "pane focus target";
	document.body.append(groupFocusTarget);
	const groupApi = {
		isVisible: true,
		width: 800,
		height: 400,
		setVisible: () => {},
		onWillFocus: (listener: typeof onWillFocus) => {
			onWillFocus = listener;
			return { dispose: () => {} };
		},
	};
	const paneApi = {
		id: "pane-a",
		isActive: true,
		isVisible: true,
		isGroupActive: true,
		setActive: () => {},
		getWindow: () => window,
		onDidActiveChange: () => ({ dispose: () => {} }),
		onDidVisibilityChange: () => ({ dispose: () => {} }),
		onDidActiveGroupChange: () => ({ dispose: () => {} }),
		onDidGroupChange: () => ({ dispose: () => {} }),
		group: undefined as unknown as {
			api: typeof groupApi;
			element: HTMLElement;
		},
	};
	const group = {
		api: groupApi,
		element: groupFocusTarget,
		panels: [] as unknown[],
	};
	paneApi.group = group;
	const panel = { api: paneApi, group };
	group.panels = [panel];
	const requestFocus = () => {
		let defaultPrevented = false;
		onWillFocus?.({
			preventDefault: () => {
				defaultPrevented = true;
			},
		});
		if (!defaultPrevented) groupFocusTarget.focus();
		return defaultPrevented;
	};
	return {
		paneApi,
		dockviewApi: {
			focus: requestFocus,
			getPanel: (panelId: string) => (panelId === paneApi.id ? panel : undefined),
		},
		requestFocus,
		dispose: () => groupFocusTarget.remove(),
	};
}

const tracedTextInputs = [
	[
		"IME composition commit",
		"한",
		(input: HTMLTextAreaElement, text: string) => {
			fireEvent.compositionStart(input, { data: "ㅎ" });
			fireEvent.compositionUpdate(input, { data: text });
			fireEvent.input(input, { target: { value: text } });
			fireEvent.compositionEnd(input, { data: text });
			fireEvent.input(input, { target: { value: text } });
		},
	],
	[
		"ordinary multiline input",
		"first line\n둘째 줄",
		(input: HTMLTextAreaElement, text: string) => {
			fireEvent.input(input, { target: { value: text } });
		},
	],
] as const;

describe("StructuredTerminalView resize transaction", () => {
	it.each([
		["before-frame", false],
		["before-frame", true],
		["read-only", false],
		["read-only", true],
	] as const)(
		"honors a body click after %s becomes ready (interrupted=%s)",
		async (phase, interrupted) => {
			const focus = structuredPaneFocusHarness();
			const onRecords = installAttachMock();
			const props = {
				paneApi: focus.paneApi,
				inputDisabled: phase === "read-only",
			} as unknown as Partial<ComponentProps<typeof StructuredTerminalView>>;
			const view = renderTerminalView(props);
			const outside = document.createElement("input");
			document.body.append(outside);
			const dispose = registerTestCleanup(() => {
				outside.remove();
				focus.dispose();
			});
			try {
				await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
				if (phase === "read-only") await deliverViewportFrame(onRecords[0]);
				outside.focus();
				expect(terminalInput(view).disabled).toBe(true);
				const viewport = terminalViewport(view.container);
				fireEvent.pointerDown(viewport, { pointerId: 753, button: 0, buttons: 1 });
				fireEvent.pointerUp(viewport, { pointerId: 753, button: 0, buttons: 0 });
				expect(document.activeElement).toBe(outside);
				expect(sentInputIntents("key")).toHaveLength(0);
				expect(sentInputIntents("text")).toHaveLength(0);
				if (interrupted) fireEvent.pointerDown(outside);
				if (phase === "before-frame") await deliverViewportFrame(onRecords[0]);
				else {
					view.rerender(
						cloneElement(terminalElement("session-a"), {
							...props,
							inputDisabled: false,
						}),
					);
				}
				await waitFor(() => expect(terminalInput(view).disabled).toBe(false));
				expect(document.activeElement).toBe(
					interrupted ? outside : terminalInput(view),
				);
				expect(sentInputIntents("key")).toHaveLength(0);
				expect(sentInputIntents("text")).toHaveLength(0);
			} finally {
				dispose();
			}
		},
	);

	it("suppresses repeated user input while recovered history is read-only", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ inputDisabled: true });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		mocks.send.mockClear();
		const input = terminalInput(view);

		pressEnter(input);
		pressEnter(input);
		fireEvent.input(input, { target: { value: "retry" } });

		expect(input.disabled).toBe(true);
		expect(sentRecords("inputIntent")).toHaveLength(0);
	});

	it("blurs and disables the input while its desktop is hidden, so keystrokes cannot reach the hidden session", async () => {
		const { view } = await bootTerminalWithFrame();
		const input = terminalInput(view);
		input.focus();
		expect(document.activeElement).toBe(input);
		expect(input.disabled).toBe(false);

		mocks.workspaceActive = false;
		await act(async () => {
			view.rerender(terminalElement("session-a"));
		});
		expect(document.activeElement).not.toBe(input);
		expect(input.disabled).toBe(true);
		mocks.send.mockClear();
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				code: "Enter",
				key: "Enter",
			}),
		);
		await flushFrames();
		expect(sentRecords("inputIntent")).toHaveLength(0);

		mocks.workspaceActive = true;
		await act(async () => {
			view.rerender(terminalElement("session-a"));
		});
		expect(input.disabled).toBe(false);
	});

	it("keeps terminal input inert until the first complete viewport frame", async () => {
		const { onRecords, view } = await bootTerminal();
		const input = terminalInput(view);
		const beforeFrame = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			code: "Enter",
			key: "Enter",
		});

		input.dispatchEvent(beforeFrame);

		expect(beforeFrame.defaultPrevented).toBe(false);
		expect(sentRecords("inputIntent")).toHaveLength(0);
		await flushFrames();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		mocks.send.mockClear();
		const afterFrame = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			code: "Enter",
			key: "Enter",
		});

		input.dispatchEvent(afterFrame);

		expect(afterFrame.defaultPrevented).toBe(true);
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
	});

	it("does not forward delayed terminal text after keyboard ownership moves to search", async () => {
		const { view } = await bootTerminalWithFrame();
		const paneInput = terminalInput(view);
		const searchInput = document.createElement("input");
		searchInput.setAttribute("aria-label", "Sessions 검색");
		document.body.append(searchInput);

		paneInput.focus();
		searchInput.focus();
		mocks.send.mockClear();

		fireEvent.input(paneInput, { target: { value: "design-labs" } });
		fireEvent.input(paneInput, { target: { value: "" } });

		expect(document.activeElement).toBe(searchInput);
		expect.soft(sentInputIntents("text")).toHaveLength(0);
		expect
			.soft(view.queryByText(/text input is empty or oversized/))
			.toBeNull();

		paneInput.focus();
		mocks.send.mockClear();
		fireEvent.input(paneInput, { target: { value: "pwd" } });

		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		searchInput.remove();
	});

	it("hands an exact pane focus request to the current recovered attachment", async () => {
		const focus = structuredPaneFocusHarness();
		const onRecords = installAttachMock();
		const view = renderTerminalView(
			{ paneApi: focus.paneApi } as unknown as Partial<
				ComponentProps<typeof StructuredTerminalView>
			>,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		mocks.send.mockClear();

		const defaultPrevented = focus.dockviewApi.focus();

		const input = terminalInput(view);
		await waitFor(() => expect(document.activeElement).toBe(input));
		pressEnter(document.activeElement as Element);
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		expect(defaultPrevented).toBe(true);
		focus.dispose();
	});

	it("measures the exact pane focus through textarea ownership and paint", async () => {
		const focus = structuredPaneFocusHarness();
		mocks.desktopId = "structured-focus-desktop";
		const beginPaneFocus = vi.spyOn(workspacePerformance, "beginPaneFocus");
		const originalPaint =
			workspacePerformance.markPaneFocusPaint.bind(workspacePerformance);
		let expectedSequence: number | undefined;
		let resolvePaint: (() => void) | undefined;
		const painted = new Promise<void>((resolve) => {
			resolvePaint = resolve;
		});
		const markPaneFocusPaint = vi
			.spyOn(workspacePerformance, "markPaneFocusPaint")
			.mockImplementation((sequence) => {
				originalPaint(sequence);
				if (sequence === expectedSequence) resolvePaint?.();
			});
		const dispose = registerTestCleanup(() => {
			markPaneFocusPaint.mockRestore();
			beginPaneFocus.mockRestore();
			focus.dispose();
		});
		const onRecords = installAttachMock();
		const view = renderTerminalView(
			{ paneApi: focus.paneApi } as unknown as Partial<
				ComponentProps<typeof StructuredTerminalView>
			>,
		);
		try {
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);
			mocks.send.mockClear();

			focus.requestFocus();
			expect(beginPaneFocus).toHaveBeenCalledOnce();
			expectedSequence = beginPaneFocus.mock.results[0]?.value;
			expect(expectedSequence).toEqual(expect.any(Number));
			await Promise.resolve();
			await flushFrames();
			await painted;

			const sample = workspacePerformance
				.snapshot()
				.paneFocus?.find(({ sequence }) => sequence === expectedSequence);
			expect(sample).toMatchObject({
				desktopId: "structured-focus-desktop",
				panelId: "pane-a",
				terminal: true,
				commitMs: expect.any(Number),
				eventMicrotaskMs: expect.any(Number),
				eventMessageTaskMs: expect.any(Number),
				eventTaskMs: null,
				firstFrameMs: expect.any(Number),
				terminalInputFocusCommitMs: expect.any(Number),
				terminalInputFocusCallMs: expect.any(Number),
				terminalInputFocusPreHandlerMs: expect.any(Number),
				terminalInputFocusHandlerMs: expect.any(Number),
				terminalInputFocusPostHandlerMs: expect.any(Number),
				terminalInputFocusProjectionMs: expect.any(Number),
				terminalInputFocusIntentDispatchMs: expect.any(Number),
				terminalInputFocusNativeRemainderMs: expect.any(Number),
				paintMs: expect.any(Number),
				interactiveMs: expect.any(Number),
				outcome: "complete",
			});
			if (
				typeof sample?.terminalInputFocusPreHandlerMs !== "number" ||
				typeof sample.terminalInputFocusHandlerMs !== "number" ||
				typeof sample.terminalInputFocusPostHandlerMs !== "number" ||
				typeof sample.terminalInputFocusProjectionMs !== "number" ||
				typeof sample.terminalInputFocusIntentDispatchMs !== "number" ||
				typeof sample.terminalInputFocusNativeRemainderMs !== "number"
			) {
				throw new Error("terminal focus stage attribution is missing");
			}
			const attributedHandlerMs =
				sample.terminalInputFocusProjectionMs +
					sample.terminalInputFocusIntentDispatchMs;
			expect(attributedHandlerMs).toBeLessThanOrEqual(
				sample.terminalInputFocusHandlerMs,
			);
			expect(
				sample.terminalInputFocusPreHandlerMs +
					sample.terminalInputFocusHandlerMs +
					sample.terminalInputFocusPostHandlerMs,
			).toBeCloseTo(sample.terminalInputFocusCallMs, 6);
			expect(
				sample.terminalInputFocusPreHandlerMs +
					sample.terminalInputFocusPostHandlerMs,
			).toBeCloseTo(sample.terminalInputFocusNativeRemainderMs, 6);
			expect(sentInputIntents("focus")).toHaveLength(1);
			expect(document.activeElement).toBe(terminalInput(view));
		} finally {
			dispose();
		}
	});

	it("hands pane focus to the textarea without rerendering the terminal view", async () => {
		const focus = structuredPaneFocusHarness();
		const commitPhases: string[] = [];
		const onRecords = installAttachMock();
		const view = render(
			<Profiler
				id="structured-terminal-focus"
				onRender={(_id, phase) => commitPhases.push(phase)}
			>
				<StructuredTerminalView
					sessionId="session-a"
					surfaceId="pane-a"
					binding={hmuxPaneBinding("session-a")}
					paneApi={focus.paneApi as never}
				/>
			</Profiler>,
		);
		try {
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);
			commitPhases.length = 0;
			mocks.send.mockClear();

			let defaultPrevented = false;
			act(() => {
				defaultPrevented = focus.requestFocus();
			});
			await waitFor(() => expect(sentInputIntents("focus")).toHaveLength(1));
			await flushFrames();

			expect(defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(terminalInput(view));
			expect(terminalViewport(view.container).classList).toContain("focused");
			// Index access, not .at(-1): tsconfig's lib is ES2020 and Array.at
			// arrived in ES2022, so the call does not typecheck here.
			const paneFocus = workspacePerformance.snapshot().paneFocus ?? [];
			expect(paneFocus[paneFocus.length - 1]?.outcome).toBe("complete");
			expect(commitPhases).toEqual([]);
		} finally {
			focus.dispose();
		}
	});

	it("measures a natural viewport click through textarea ownership and paint", async () => {
		const focus = structuredPaneFocusHarness();
		mocks.desktopId = "structured-focus-desktop";
		const beginPaneFocus = vi.spyOn(workspacePerformance, "beginPaneFocus");
		const originalPaint =
			workspacePerformance.markPaneFocusPaint.bind(workspacePerformance);
		let resolvePaint: ((sequence: number) => void) | undefined;
		const painted = new Promise<number>((resolve) => {
			resolvePaint = resolve;
		});
		const markPaneFocusPaint = vi
			.spyOn(workspacePerformance, "markPaneFocusPaint")
			.mockImplementation((sequence) => {
				originalPaint(sequence);
				resolvePaint?.(sequence);
			});
		const onRecords = installAttachMock();
		const view = renderTerminalView(
			{ paneApi: focus.paneApi } as unknown as Partial<
				ComponentProps<typeof StructuredTerminalView>
			>,
		);
		const tabFocusTarget = document.createElement("button");
		tabFocusTarget.textContent = "inactive terminal tab";
		document.body.append(tabFocusTarget);
		const dispose = registerTestCleanup(() => {
			tabFocusTarget.remove();
			markPaneFocusPaint.mockRestore();
			beginPaneFocus.mockRestore();
			focus.dispose();
		});
		try {
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);
			beginPaneContentFocus(focus.paneApi);
			tabFocusTarget.focus();

			const viewport = terminalViewport(view.container);
			fireEvent.pointerDown(viewport, {
				pointerId: 41,
				button: 0,
				buttons: 1,
				clientX: 10,
				clientY: 10,
			});
			fireEvent.pointerUp(viewport, {
				pointerId: 41,
				button: 0,
				buttons: 0,
				clientX: 10,
				clientY: 10,
			});

			expect(beginPaneFocus).toHaveBeenCalledOnce();
			await Promise.resolve();
			await flushFrames();
			const expectedSequence = await painted;
			const sample = workspacePerformance
				.snapshot()
				.paneFocus?.find(({ sequence }) => sequence === expectedSequence);
			expect(sample).toMatchObject({
				desktopId: "structured-focus-desktop",
				panelId: "pane-a",
				terminal: true,
				terminalInputFocusCommitMs: expect.any(Number),
				paintMs: expect.any(Number),
				interactiveMs: expect.any(Number),
				outcome: "complete",
			});
			expect(document.activeElement).toBe(terminalInput(view));
			// The newer body click settles the same handoff as keyboard navigation;
			// a completed focus must not leave an older request pending.
			expect(currentPaneContentFocus(focus.paneApi)).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("aborts pane focus paint after a newer pointer intent", async () => {
		const focus = structuredPaneFocusHarness();
		const outside = document.createElement("div");
		document.body.append(outside);
		mocks.desktopId = "structured-focus-desktop";
		const beginPaneFocus = vi.spyOn(workspacePerformance, "beginPaneFocus");
		const originalAbort =
			workspacePerformance.abortPaneFocus.bind(workspacePerformance);
		let expectedSequence: number | undefined;
		let resolveAbort: (() => void) | undefined;
		const aborted = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const abortPaneFocus = vi
			.spyOn(workspacePerformance, "abortPaneFocus")
			.mockImplementation((sequence) => {
				originalAbort(sequence);
				if (sequence === expectedSequence) resolveAbort?.();
			});
		const dispose = registerTestCleanup(() => {
			abortPaneFocus.mockRestore();
			beginPaneFocus.mockRestore();
			outside.remove();
			focus.dispose();
		});
		const onRecords = installAttachMock();
		const view = renderTerminalView(
			{ paneApi: focus.paneApi } as unknown as Partial<
				ComponentProps<typeof StructuredTerminalView>
			>,
		);
		try {
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);

			focus.requestFocus();
			expect(beginPaneFocus).toHaveBeenCalledOnce();
			expectedSequence = beginPaneFocus.mock.results[0]?.value;
			expect(expectedSequence).toEqual(expect.any(Number));
			expect(document.activeElement).toBe(terminalInput(view));
			fireEvent.pointerDown(outside);
			await Promise.resolve();
			await flushFrames();
			await aborted;

			const sample = workspacePerformance
				.snapshot()
				.paneFocus?.find(({ sequence }) => sequence === expectedSequence);
			expect(sample).toMatchObject({
				terminalInputFocusCommitMs: expect.any(Number),
				paintMs: null,
				interactiveMs: null,
				outcome: "aborted",
			});
		} finally {
			dispose();
		}
	});

	it("retains a navigation focus transaction until the recovered pane mounts", async () => {
		const focus = structuredPaneFocusHarness();
		mocks.desktopId = "structured-focus-desktop";
		const beginPaneFocus = vi.spyOn(workspacePerformance, "beginPaneFocus");
		const originalPaint =
			workspacePerformance.markPaneFocusPaint.bind(workspacePerformance);
		let resolvePaint: ((sequence: number) => void) | undefined;
		const painted = new Promise<number>((resolve) => {
			resolvePaint = resolve;
		});
		const markPaneFocusPaint = vi
			.spyOn(workspacePerformance, "markPaneFocusPaint")
			.mockImplementation((sequence) => {
				originalPaint(sequence);
				resolvePaint?.(sequence);
			});
		registerDockview(
			"structured-focus-desktop",
			focus.dockviewApi as never,
		);
		const dispose = registerTestCleanup(() => {
			markPaneFocusPaint.mockRestore();
			beginPaneFocus.mockRestore();
			unregisterDockview(
				"structured-focus-desktop",
				focus.dockviewApi as never,
			);
			focus.dispose();
		});
		try {
			navigateToPanel("structured-focus-desktop", "pane-a");
			const retainedRequest = currentPaneContentFocus(focus.paneApi);
			expect(retainedRequest).toBeDefined();
			const onRecords = installAttachMock();
			const view = renderTerminalView(
				{ paneApi: focus.paneApi } as unknown as Partial<
					ComponentProps<typeof StructuredTerminalView>
				>,
			);
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);

			expect(document.activeElement).toBe(terminalInput(view));
			expect(beginPaneFocus).toHaveBeenCalledOnce();
			await Promise.resolve();
			await flushFrames();
			const expectedSequence = await painted;
			const sample = workspacePerformance
				.snapshot()
				.paneFocus?.find(({ sequence }) => sequence === expectedSequence);
			expect(sample).toMatchObject({
				desktopId: "structured-focus-desktop",
				panelId: "pane-a",
				terminal: true,
				terminalInputFocusCommitMs: expect.any(Number),
				paintMs: expect.any(Number),
				interactiveMs: expect.any(Number),
				outcome: "complete",
			});
			expect(beginPaneFocus).toHaveBeenCalledWith(
				"structured-focus-desktop",
				"pane-a",
				true,
				retainedRequest?.requestedAt,
			);
			expect(currentPaneContentFocus(focus.paneApi)).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("drops a pending pane focus request after Sessions search takes keyboard ownership", async () => {
		const focus = structuredPaneFocusHarness();
		const onRecords = installAttachMock();
		const view = renderTerminalView(
			{ paneApi: focus.paneApi } as unknown as Partial<
				ComponentProps<typeof StructuredTerminalView>
			>,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		const searchInput = document.createElement("input");
		searchInput.setAttribute("aria-label", "Sessions 검색");
		document.body.append(searchInput);
		const defaultPrevented = focus.requestFocus();
		searchInput.focus();
		mocks.send.mockClear();
		await deliverViewportFrame(onRecords[0]);

		expect(defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(searchInput);
		expect(sentInputIntents("focus")).toHaveLength(0);
		expect(terminalInput(view).disabled).toBe(false);
		searchInput.remove();
		focus.dispose();
	});

	it("enqueues a mixed-script typing burst without waiting for each native round trip", async () => {
		const releaseSends: Array<() => void> = [];
		const { view } = await bootTerminalWithFrame();
		mocks.send.mockClear();
		mocks.send.mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					releaseSends.push(() => resolve("queued"));
				}),
		);
		const input = terminalInput(view);

		input.focus();
		for (const text of ["a", "한", "é", "🙂"]) {
			fireEvent.input(input, { target: { value: text } });
		}

		await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(5));
		const records = sentRecords("inputIntent");
		expect(records.map(({ metadata }) => metadata.recordId)).toEqual([
			2n,
			3n,
			4n,
			5n,
			6n,
		]);
		expect(
			records.map(({ record }) =>
				record.body.case === "inputIntent"
					? record.body.value.intent.case
					: "missing",
			),
		).toEqual(["focus", "text", "text", "text", "text"]);
		expect(sentTextPayloads()).toEqual(["a", "한", "é", "🙂"]);

		await act(async () => {
			for (const release of releaseSends) release();
		});
	});

	it("recovers a burst once when bounded native enqueue reports backpressure", async () => {
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const recoverySeed = viewportFrameRecord();
				request.onRecord(recoverySeed.buffer as ArrayBuffer);
			}
			return undefined;
		});
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		mocks.send.mockClear();
		mocks.send.mockRejectedValue(
			new Error(
				"hmux_structured_upstream_backpressure: structured terminal upstream queue is full",
			),
		);
		const input = terminalInput(view);

		input.focus();
		fireEvent.input(input, { target: { value: "a" } });
		fireEvent.input(input, { target: { value: "β" } });

		expect(mocks.send).toHaveBeenCalledTimes(3);
		expect(
			sentRecords("inputIntent").map(({ metadata }) => metadata.recordId),
		).toEqual([2n, 3n, 4n]);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(mocks.attach).toHaveBeenCalledTimes(2);
		expect(
			view.getByText(/hmux_structured_upstream_backpressure/),
		).toBeTruthy();
	});

	it("retires an input send attachment-race error after the successor serves a complete frame", async () => {
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const recoverySeed = viewportFrameRecord({
					texts: ["recovered attachment"],
				});
				request.onRecord(recoverySeed.buffer as ArrayBuffer);
			}
			return undefined;
		});
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		const input = terminalInput(view);
		input.focus();
		await waitFor(() => expect(sentInputIntents("focus")).toHaveLength(1));
		mocks.send.mockClear();
		mocks.send.mockRejectedValueOnce(
			new Error("structured terminal connection is not attached"),
		);

		pressEnter(input);

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"recovered attachment",
			),
		);
		expect(
			view.queryByText(/structured terminal connection is not attached/),
		).toBeNull();
	});

	it("accepts one correlated binary input receipt without reattaching", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		mocks.send.mockClear();
		const input = terminalInput(view);

		pressEnter(input);

		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		const [sent] = sentInputIntents("key");
		expect(sent).toBeDefined();
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(sent.metadata.recordId),
		);

		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(view.queryByText(/structured terminal expected/)).toBeNull();
	});

	it.each(["production", "perf"])("traces one real keydown through its exact Host receipt, projection, and output paint (%s)", async (mode) => {
		vi.stubEnv("MODE", mode);
		mocks.desktopId = "desktop-a";
		const { onRecords, view } = await bootTerminalWithFrame({
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
			texts: ["before input"],
		});
		mocks.send.mockClear();
		const input = view.getByRole("textbox", {
			name: "터미널 입력",
		}) as HTMLTextAreaElement;
		const outputReceived = vi.spyOn(
			terminalInputLatency,
			"markOutputReceived",
		);

		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		const [sent] = sentInputIntents("key");
		expect(sent).toBeDefined();
		const inputOutputTiming = {
			inputBaselineOutputSequence: 11n,
			firstOutputSequence: 12n,
			inputToOutputMicros: 4_200n,
			outputToProjectionStartMicros: 1_500n,
			inputRecordId: sent?.metadata.recordId ?? 0n,
		};
		try {
			await act(async () => {
				onRecords[0]?.(
					viewportFrameRecord({
						projectionRevision: 8n,
						stateRevision: 10n,
						throughOutputSeq: 12n,
						texts: ["after input"],
						inputOutputTiming,
					}).buffer as ArrayBuffer,
				);
				for (let attempt = 0; attempt < 10; attempt += 1) {
					if (outputReceived.mock.calls.length > 0) break;
					await Promise.resolve();
				}
				if (mode === "perf") {
					expect(outputReceived).toHaveBeenCalledWith(
						"pane-a",
						expect.objectContaining({
							firstCarrierResolvedAt: expect.any(Number),
							replicaAppliedAt: expect.any(Number),
						}),
					);
				} else {
					expect(outputReceived).toHaveBeenCalledWith("pane-a");
				}
				expect(visibleTerminalText(view.container)).toContain("after input");
			});
		} finally {
			outputReceived.mockRestore();
		}
		expect(terminalInputLatency.snapshot().inFlightCount).toBe(1);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(sent?.metadata.recordId ?? 0n),
		);
		await flushFrames();

		await waitFor(() =>
			expect(terminalInputLatency.snapshot()).toMatchObject({
				inFlightCount: 0,
				samples: [
					{
						desktopId: "desktop-a",
						echoFrameMs: expect.any(Number),
						echoTaskMs: expect.any(Number),
						echoPaintMs: expect.any(Number),
						frameBeforeTask: expect.any(Boolean),
						hostReceiptMs: expect.any(Number),
						hostInputAcceptedToOutputMs: 4.2,
						hostOutputToProjectionStartMs: 1.5,
						outcome: "complete",
						outputReceivedMs: expect.any(Number),
						projectionCommittedMs: expect.any(Number),
						projectionStartedMs: expect.any(Number),
						source: "keydown",
						terminalId: "pane-a",
					},
				],
			}),
		);
		const [sample] = terminalInputLatency.snapshot().samples;
		expect(sample).toBeDefined();
		if (mode === "perf") {
			expect(sample).toMatchObject({
				carrierPartCount: 1,
				carrierDecodeWorkMs: expect.any(Number),
			});
			const stages = [
				sample.carrierFirstResolvedMs, sample.carrierLastResolvedMs,
				sample.carrierDecodeStartedMs, sample.carrierDecodedMs,
				sample.replicaApplyStartedMs, sample.replicaAppliedMs, sample.outputReceivedMs,
			];
			for (let index = 1; index < stages.length; index += 1) {
				expect(stages[index]).toBeGreaterThanOrEqual(stages[index - 1] ?? Infinity);
			}
		} else {
			expect(sample).not.toHaveProperty("carrierFirstResolvedMs");
		}
		const splitSample = sample as typeof sample & {
			echoFrameMs: number;
			echoTaskMs: number;
		};
		expect(sample?.outputReceivedMs).toBeLessThanOrEqual(
			sample?.projectionStartedMs ?? -1,
		);
		expect(sample?.projectionStartedMs).toBeLessThanOrEqual(
			sample?.projectionCommittedMs ?? -1,
		);
		expect(sample?.projectionCommittedMs).toBeLessThanOrEqual(
			splitSample.echoFrameMs,
		);
		expect(sample?.projectionCommittedMs).toBeLessThanOrEqual(
			splitSample.echoTaskMs,
		);
		expect(splitSample.echoFrameMs).toBeLessThanOrEqual(
			sample?.echoPaintMs ?? -1,
		);
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 9n,
				stateRevision: 11n,
				throughOutputSeq: 13n,
				texts: ["ordinary streaming frame"],
				inputOutputTiming,
			}),
		);
		expect(visibleTerminalText(view.container)).toContain("after input");
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain(
			"ordinary streaming frame",
		);
		expect(mocks.attach).toHaveBeenCalledOnce();
	});

	it("keeps one printable keydown correlated through native text input and exact Host paint", async () => {
		mocks.desktopId = "desktop-a";
		const { onRecords, view } = await bootTerminalWithFrame({
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
			texts: ["before input"],
		});
		mocks.send.mockClear();
		const input = terminalInput(view);
		input.focus();

		fireEvent.keyDown(input, { key: "a", code: "KeyA" });
		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				cancelable: true,
				inputType: "insertText",
				data: "a",
			}),
		);
		fireEvent.input(input, { target: { value: "a" } });

		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		const [sent] = sentInputIntents("text");
		expect(sent).toBeDefined();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 8n,
				stateRevision: 10n,
				throughOutputSeq: 12n,
				texts: ["after input"],
				inputOutputTiming: {
					inputBaselineOutputSequence: 11n,
					firstOutputSequence: 12n,
					inputToOutputMicros: 4_200n,
					outputToProjectionStartMicros: 1_500n,
					inputRecordId: sent?.metadata.recordId ?? 0n,
				},
			}),
		);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(sent?.metadata.recordId ?? 0n),
		);
		await flushFrames();

		await waitFor(() =>
			expect(terminalInputLatency.snapshot()).toMatchObject({
				inFlightCount: 0,
				samples: [
					{
						captureToSemanticHandlerMs: expect.any(Number),
						desktopId: "desktop-a",
						echoPaintMs: expect.any(Number),
						hostInputAcceptedToOutputMs: 4.2,
						hostOutputToProjectionStartMs: 1.5,
						hostReceiptMs: expect.any(Number),
						outcome: "complete",
						semanticDecisionToDispatchMs: expect.any(Number),
						semanticHandlerToDecisionMs: expect.any(Number),
						semanticHandlerToDispatchMs: expect.any(Number),
						source: "keydown",
						terminalId: "pane-a",
					},
				],
			}),
		);
		expect(visibleTerminalText(view.container)).toContain("after input");
		expect(mocks.attach).toHaveBeenCalledOnce();
	});

	it("separates a replacement-active key capture from semantic dispatch", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();

		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "ㅎ",
			}),
		);
		fireEvent.input(input, { target: { value: "ㅎ" } });
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		expect(view.queryByTestId("structured-terminal-composition")).toBeNull();

		// Keep the replacement lifecycle active while starting a fresh measurement
		// phase for the following ordinary semantic key.
		terminalInputLatency.resetMeasurements();
		mocks.send.mockClear();
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		const [sent] = sentInputIntents("key");
		await deliverRecord(
			onRecords[0],
			inputRefusedReceiptRecord(sent?.metadata.recordId ?? 0n),
		);

		const [sample] = terminalInputLatency.snapshot().samples;
		const separated = sample as typeof sample & {
			captureToSemanticHandlerMs: number;
			replacementChainActiveAtCapture: boolean;
			semanticDecisionToDispatchMs: number;
			semanticHandlerToDecisionMs: number;
			semanticHandlerToDispatchMs: number;
		};
		expect(separated).toMatchObject({
			captureToSemanticHandlerMs: expect.any(Number),
			outcome: "failed",
			replacementChainActiveAtCapture: true,
			semanticDecisionToDispatchMs: expect.any(Number),
			semanticHandlerToDecisionMs: expect.any(Number),
			semanticHandlerToDispatchMs: expect.any(Number),
			source: "keydown",
		});
		expect(
			separated.captureToSemanticHandlerMs +
				separated.semanticHandlerToDecisionMs +
				separated.semanticDecisionToDispatchMs,
		).toBeCloseTo(separated.dispatchMs, 6);
		expect(
			separated.semanticHandlerToDecisionMs +
				separated.semanticDecisionToDispatchMs,
		).toBeCloseTo(separated.semanticHandlerToDispatchMs, 6);
		expect(input.value).toBe("");
		expect(view.queryByTestId("structured-terminal-composition")).toBeNull();
	});

	it("separates transport confirmation from an earlier exact Host receipt", async () => {
		const { onRecords, view } = await bootTerminalWithFrame({
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
		});
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		let confirmTransport: ((receipt: string) => void) | undefined;
		mocks.send.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					confirmTransport = resolve;
				}),
		);

		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		const [sent] = sentInputIntents("key");
		const recordId = sent?.metadata.recordId ?? 0n;
		await deliverRecord(onRecords[0], inputReceiptRecord(recordId));

		await act(async () => {
			confirmTransport?.("queued");
			await Promise.resolve();
		});
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 8n,
			stateRevision: 10n,
			throughOutputSeq: 12n,
			inputOutputTiming: {
				inputBaselineOutputSequence: 11n,
				firstOutputSequence: 12n,
				inputToOutputMicros: 300n,
				outputToProjectionStartMicros: 100n,
				inputRecordId: recordId,
			},
		});
		await flushFrames();

		await waitFor(() =>
			expect(terminalInputLatency.snapshot()).toMatchObject({
				inFlightCount: 0,
				samples: [
					{
						hostReceiptBeforeTransportConfirmation: true,
						outcome: "complete",
						source: "keydown",
						transportConfirmationMs: expect.any(Number),
					},
				],
			}),
		);
	});

	it.each(tracedTextInputs)(
		"anchors one %s before semantic dispatch and exact output paint",
		async (_label, text, dispatch) => {
			const { onRecords, view } = await bootTerminalWithFrame({
				projectionRevision: 7n,
				stateRevision: 9n,
				throughOutputSeq: 11n,
			});
			const input = terminalInput(view);
			input.focus();
			mocks.send.mockClear();
			let now = 10;
			const originalNoteInput =
				terminalInputLatency.noteInput.bind(terminalInputLatency);
			const performanceNow = vi
				.spyOn(performance, "now")
				.mockImplementation(() => now);
			const noteInput = vi
				.spyOn(terminalInputLatency, "noteInput")
				.mockImplementation((terminalId, options) => {
					originalNoteInput(terminalId, options);
					now = 17;
				});

			try {
				dispatch(input, text);

				await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
				expect(noteInput).toHaveBeenCalledOnce();
				expect(sentTextPayloads()).toEqual([text]);
				const [sent] = sentInputIntents("text");
				expect(sent).toBeDefined();
				now = 20;
				await deliverRecord(
					onRecords[0],
					inputReceiptRecord(sent?.metadata.recordId ?? 0n),
				);
				now = 23;
				await deliverViewportFrame(onRecords[0], {
					projectionRevision: 8n,
					stateRevision: 10n,
					throughOutputSeq: 12n,
				});
				await flushFrames();
				expect(terminalInputLatency.snapshot().inFlightCount).toBe(1);

				now = 25;
				await deliverViewportFrame(onRecords[0], {
					projectionRevision: 9n,
					stateRevision: 11n,
					throughOutputSeq: 13n,
					inputOutputTiming: {
						inputBaselineOutputSequence: 12n,
						firstOutputSequence: 13n,
						inputToOutputMicros: 4_200n,
						outputToProjectionStartMicros: 1_500n,
						inputRecordId: sent?.metadata.recordId ?? 0n,
					},
				});
				now = 30;
				await flushFrames();

				await waitFor(() =>
					expect(terminalInputLatency.snapshot()).toMatchObject({
						inFlightCount: 0,
						samples: [
							{
								dispatchMs: 7,
								echoFrameMs: expect.any(Number),
								echoPaintMs: expect.any(Number),
								echoTaskMs: expect.any(Number),
								hostInputAcceptedToOutputMs: 4.2,
								hostOutputToProjectionStartMs: 1.5,
								outcome: "complete",
								projectionCommittedMs: expect.any(Number),
								projectionStartedMs: expect.any(Number),
								source: "input",
								terminalId: "pane-a",
							},
						],
					}),
				);
			} finally {
				noteInput.mockRestore();
				performanceNow.mockRestore();
			}
		},
	);

	it("separates a sampled input whose exact timing is superseded before projection", async () => {
		const { onRecords, view } = await bootTerminalWithFrame({
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
		});
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		let confirmTransport: ((receipt: string) => void) | undefined;
		mocks.send.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					confirmTransport = resolve;
				}),
		);

		fireEvent.input(input, { target: { value: "가" } });
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		const [sampled] = sentInputIntents("text");
		expect(sampled).toBeDefined();

		fireEvent.input(input, { target: { value: "나" } });
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(2));
		const [, successor] = sentInputIntents("text");
		expect(successor).toBeDefined();

		// The Host observed the sampled input's output at sequence 12, then a
		// rapid successor at baseline 12. Projection coalesced both generations,
		// so its replaceable timing metadata now identifies only the successor.
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 8n,
			stateRevision: 10n,
			throughOutputSeq: 13n,
			texts: ["가나"],
			inputOutputTiming: {
				inputBaselineOutputSequence: 12n,
				firstOutputSequence: 13n,
				inputToOutputMicros: 300n,
				outputToProjectionStartMicros: 100n,
				inputRecordId: successor?.metadata.recordId ?? 0n,
			},
		});
		expect(terminalInputLatency.snapshot().inFlightCount).toBe(1);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(sampled?.metadata.recordId ?? 0n),
		);
		expect(terminalInputLatency.snapshot()).toMatchObject({
			inFlightCount: 1,
			samples: [],
		});
		await act(async () => {
			confirmTransport?.("queued");
			await Promise.resolve();
		});

		expect(terminalInputLatency.snapshot()).toMatchObject({
			inFlightCount: 0,
			samples: [
				{
					hostReceiptMs: expect.any(Number),
					outcome: "correlation_superseded",
					source: "input",
					successorOutputObserved: true,
					transportConfirmationMs: expect.any(Number),
				},
			],
		});
	});

	it.each([false, true])(
		"keeps a correlated input refusal out of session recovery (automatic=%s)",
		async (automatic) => {
			const onRecords = installAttachMock();
			const resume = vi.fn(async () => {});
			const onAttachRecoveryPresentationChange = vi.fn();
			const { probe, qaSurface } = createWindowFocusProbe();
			const view = renderTerminalView({
				attachRecovery: { ownerKey: "fixture-runtime", intent: "resume", resume, automatic, context: "pane-a" },
				onAttachRecoveryPresentationChange,
				windowFocusProbe: probe,
			});
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await waitFor(() => expect(probe.connect).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);
			mocks.send.mockClear();
			pressEnter(terminalInput(view));
			await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
			const [sent] = sentInputIntents("key");

			await deliverRecord(
				onRecords[0],
				inputRefusedReceiptRecord(sent?.metadata.recordId ?? 0n),
			);

			expect(view.getByText(/terminal input refused/)).toBeTruthy();
			expect(view.queryByRole("button", { name: "세션 이어서 재개" })).toBeNull();
			expect(onAttachRecoveryPresentationChange).not.toHaveBeenCalledWith(true);
			expect(resume).not.toHaveBeenCalled();
			await deliverViewportFrame(onRecords[0], { projectionRevision: 2n });
			expect(view.getByText(/terminal input refused/)).toBeTruthy();
			// A focus intent rides the input lane; its accepted receipt says
			// nothing about the lost keystroke (#705 review).
			qaSurface().focus();
			await waitFor(() => expect(sentInputIntents("focus")).toHaveLength(1));
			const [focusIntent] = sentInputIntents("focus");
			await deliverRecord(
				onRecords[0],
				inputReceiptRecord(focusIntent?.metadata.recordId ?? 0n),
			);
			expect(view.getByText(/terminal input refused/)).toBeTruthy();

			pressEnter(terminalInput(view));
			await waitFor(() => expect(sentInputIntents("key")).toHaveLength(2));
			expect(mocks.attach).toHaveBeenCalledOnce();
			expect(mocks.detach).not.toHaveBeenCalled();

			// Red on 2026-09-11 (#705): the notice outlived the very next
			// accepted keystroke, so a pane that typed fine still read as failed.
			const [, accepted] = sentInputIntents("key");
			await deliverRecord(
				onRecords[0],
				inputReceiptRecord(accepted?.metadata.recordId ?? 0n),
			);
			await waitFor(() =>
				expect(view.queryByText(/terminal input refused/)).toBeNull(),
			);
			expect(resume).not.toHaveBeenCalled();
		},
	);

	it("publishes a semantic QA surface with exact frame geometry and correlated focus/input receipts", async () => {
		const disconnect = vi.fn();
		const { probe, qaSurface } = createWindowFocusProbe(disconnect);
		const onRecords = installAttachMock();
		const view = renderTerminalView({ windowFocusProbe: probe });
		sizeStructuredHost(view, 800, 400);
		installCanvasPresentationProbe(view.container, () => ({
			width: 800,
			height: 400,
		}));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await waitFor(() => expect(probe.connect).toHaveBeenCalledOnce());

		const marker = "HMUX_WINDOW_QA_0123456789AB_A_0001";
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
			columns: 80,
			texts: [marker, ...Array(19).fill("")],
		});
		await waitFor(() => expect(probe.onSynchronized).toHaveBeenCalledOnce());
		const state = qaSurface().bufferState();
		expect(state).toMatchObject({
			columns: 80,
			rows: 20,
			fitColumns: 80,
			fitRows: 20,
			fitDimensionsMatch: true,
			bufferLength: 20,
			viewportY: 0,
			atBottom: true,
			concealed: false,
		});
		expect(state.viewportFill.fillsContainer).toBe(true);
		expect(qaSurface().markerCounts()).toEqual({ [marker]: 1 });
		expect(qaSurface().projectionMarkerCounts?.()).toEqual({ [marker]: 1 });
		expect(view.container.querySelector(".xterm")).toBeNull();
		const presentationCountBeforeFocus = vi.mocked(probe.onPresented).mock.calls
			.length;
		const measureCountBeforeFocus = mocks.measure.mock.calls.length;

		mocks.send.mockClear();
		const focus = qaSurface().focus();
		await waitFor(() => expect(sentInputIntents("focus")).toHaveLength(1));
		expect(terminalViewport(view.container).classList).toContain("focused");
		expect(mocks.measure).toHaveBeenCalledTimes(measureCountBeforeFocus);
		expect(probe.onPresented).toHaveBeenCalledTimes(
			presentationCountBeforeFocus,
		);
		const [focusIntent] = sentInputIntents("focus");
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(focusIntent?.metadata.recordId ?? 0n),
		);
		await expect(focus).resolves.toBeUndefined();

		const inputMarker = "HMUX_WINDOW_QA_INPUT_0123456789AB_A_0002";
		const markerWrite = qaSurface().writeMarker(inputMarker);
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		const [textIntent] = sentInputIntents("text");
		if (
			textIntent?.record.body.case !== "inputIntent" ||
			textIntent.record.body.value.intent.case !== "text"
		) {
			throw new Error("QA marker did not use a structured text intent");
		}
		expect(
			new TextDecoder().decode(textIntent.record.body.value.intent.value.utf8),
		).not.toContain(inputMarker);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(textIntent?.metadata.recordId ?? 0n),
		);
		await expect(markerWrite).resolves.toMatchObject({
			requestId: String(textIntent?.metadata.recordId),
			attachmentIdentity: expect.stringContaining("terminal-a"),
			state: "written_to_pty",
		});
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 8n,
			stateRevision: 10n,
			throughOutputSeq: 12n,
			inputOutputTiming: {
				inputBaselineOutputSequence: 11n,
				firstOutputSequence: 12n,
				inputToOutputMicros: 4_200n,
				outputToProjectionStartMicros: 1_500n,
				inputRecordId: textIntent?.metadata.recordId ?? 0n,
			},
			columns: 80,
			texts: [inputMarker, ...Array(19).fill("")],
		});
		await flushFrames();
		await waitFor(() =>
			expect(terminalInputLatency.snapshot()).toMatchObject({
				inFlightCount: 0,
				samples: [
					{
						echoPaintMs: expect.any(Number),
						hostReceiptMs: expect.any(Number),
						hostInputAcceptedToOutputMs: 4.2,
						hostOutputToProjectionStartMs: 1.5,
						outputReceivedMs: expect.any(Number),
						projectionCommittedMs: expect.any(Number),
						projectionStartedMs: expect.any(Number),
						source: "input",
						terminalId: "pane-a",
					},
				],
			}),
		);
		const presentationCountBeforeRelease = vi.mocked(probe.onPresented).mock
			.calls.length;
		const measureCountBeforeRelease = mocks.measure.mock.calls.length;

		const release = qaSurface().releaseKeyboardControl();
		await waitFor(() => expect(sentInputIntents("focus")).toHaveLength(2));
		const focusIntents = sentInputIntents("focus");
		const releaseIntent = focusIntents[focusIntents.length - 1];
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(releaseIntent?.metadata.recordId ?? 0n),
		);
		await expect(release).resolves.toBeUndefined();
		expect(terminalViewport(view.container).classList).not.toContain("focused");
		expect(mocks.measure).toHaveBeenCalledTimes(measureCountBeforeRelease);
		expect(probe.onPresented).toHaveBeenCalledTimes(
			presentationCountBeforeRelease,
		);

		view.unmount();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it("keeps a retired QA receipt out of the replacement attachment", async () => {
		const { probe, qaSurface } = createWindowFocusProbe();
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const replacementFrame = viewportFrameRecord({
					terminalEpoch: "terminal-b",
					texts: ["replacement attachment"],
				});
				request.onRecord(replacementFrame.buffer as ArrayBuffer);
			}
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const view = renderTerminalView({ windowFocusProbe: probe });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		await waitFor(() => expect(probe.connect).toHaveBeenCalledOnce());

		mocks.send.mockClear();
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		mocks.send.mockClear();
		const focus = qaSurface().focus();
		const focusOutcome = focus.then(
			() => "resolved",
			(error) => (error instanceof Error ? error.message : String(error)),
		);
		await waitFor(() => expect(sentInputIntents("focus")).toHaveLength(1));
		const [focusIntent] = sentInputIntents("focus");
		const retiredRecordId = focusIntent?.metadata.recordId ?? 0n;
		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_stream_desynchronized",
				"replace the attachment",
				"never",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"replacement attachment",
			),
		);
		await expect(focusOutcome).resolves.toContain(
			"structured terminal attachment changed",
		);
		expect(probe.connect).toHaveBeenCalledOnce();

		mocks.send.mockClear();
		const marker = "HMUX_WINDOW_QA_ABCDEF123456_B_0030";
		const replacementWrite = qaSurface().writeMarker(marker, marker);
		void replacementWrite.catch(() => {});
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		const [replacementIntent] = sentInputIntents("text");
		const replacementRecordId = replacementIntent?.metadata.recordId ?? 0n;
		expect(replacementRecordId).toBe(retiredRecordId);

		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(retiredRecordId, "terminal-a"),
		);
		expect(qaSurface().renderMetrics()).toMatchObject({
			queuedWrites: 1,
			completedWrites: 0,
		});

		await deliverRecord(
			onRecords[1],
			inputReceiptRecord(replacementRecordId, "terminal-b"),
		);
		await expect(replacementWrite).resolves.toMatchObject({
			requestId: String(replacementRecordId),
			attachmentIdentity: expect.stringContaining("terminal-b"),
			state: "written_to_pty",
		});
		expect(qaSurface().renderMetrics()).toMatchObject({
			queuedWrites: 0,
			completedWrites: 1,
		});

		view.unmount();
	});

	it("keeps a replacement attachment receipt isolated from the retired sender", async () => {
		let rejectRetiredSend!: (cause: Error) => void;
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const replacementSeed = viewportFrameRecord();
				request.onRecord(replacementSeed.buffer as ArrayBuffer);
			}
			return undefined;
		});
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		mocks.send
			.mockReset()
			.mockImplementationOnce(
				() =>
					new Promise<string>((_resolve, reject) => {
						rejectRetiredSend = reject;
					}),
			)
			.mockResolvedValue("replacement-record");
		const input = terminalInput(view);
		pressEnter(input);
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_stream_desynchronized",
				"the terminal stream is no longer frame-aligned",
				"never",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		const replacementInput = terminalInput(view);
		pressEnter(replacementInput);
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(2));

		await act(async () => {
			rejectRetiredSend(new Error("retired transport failed late"));
		});
		await act(async () => {
			const replacementRecordId = sentInputIntents("key")[1]?.metadata.recordId;
			const replacementReceipt = inputReceiptRecord(replacementRecordId ?? 0n);
			onRecords[1]?.(replacementReceipt.buffer as ArrayBuffer);
		});

		expect(
			view.queryByText(/terminal receipt does not match a pending intent/),
		).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(2);
	});

	it("sends one replacement when Korean IME backspace reports keyCode 229", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "ㅎ",
			}),
		);
		fireEvent.input(input, { target: { value: "ㅎ" } });
		fireEvent.input(input, { target: { value: "하" } });
		fireEvent.input(input, { target: { value: "한" } });
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(3));
		mocks.send.mockClear();

		fireEvent.keyDown(input, {
			key: "Backspace",
			code: "Backspace",
			keyCode: 229,
			isComposing: false,
		});
		fireEvent.input(input, { target: { value: "하" } });

		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		expect(sentTextPayloads()).toEqual(["\x7f하"]);
	});

	it("preserves a Japanese replacement chain without language detection", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();

		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "か",
			}),
		);
		fireEvent.input(input, { target: { value: "か" } });
		fireEvent.input(input, { target: { value: "が" } });

		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(2));
		expect(sentTextPayloads()).toEqual(["か", "\x7fが"]);
	});

	it("retires WKWebView replacement preedit after its canonical Host echo paints", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ columns: 10, cursorColumn: 4 }),
		);
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();

		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "ㅎ",
			}),
		);
		fireEvent.input(input, { target: { value: "ㅎ" } });
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				columns: 10,
				cursorColumn: 5,
				texts: ["spinner"],
				projectionRevision: 2n,
				throughOutputSeq: 1n,
			}),
		);
		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertReplacementText",
				data: "하",
			}),
		);
		fireEvent.input(input, { target: { value: "하" } });

		expect(input.value).toBe("하");
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(2));
		const [firstReplacement, secondReplacement] = sentInputIntents("text");
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(firstReplacement?.metadata.recordId ?? 0n),
		);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(secondReplacement?.metadata.recordId ?? 0n),
		);
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				columns: 10,
				cursorColumn: 5,
				texts: ["하"],
				projectionRevision: 3n,
				throughOutputSeq: 2n,
				inputOutputTiming: {
					inputBaselineOutputSequence: 1n,
					firstOutputSequence: 2n,
					inputToOutputMicros: 4_200n,
					outputToProjectionStartMicros: 1_500n,
					inputRecordId: secondReplacement?.metadata.recordId ?? 0n,
				},
			}),
		);
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain("하");
		expect(view.queryByTestId("structured-terminal-composition")).toBeNull();
		expect(input.style.left).toBe("50px");
		expect(input.value).toBe("하");
		expect(sentInputIntents("text")).toHaveLength(2);
		expect(sentTextPayloads()).toEqual(["ㅎ", "\x7f하"]);

		input.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertReplacementText",
				data: "한",
			}),
		);
		fireEvent.input(input, { target: { value: "한" } });

		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(3));
		expect(sentTextPayloads()).toEqual(["ㅎ", "\x7f하", "\x7f한"]);
		expect(view.queryByTestId("structured-terminal-composition")).toBeNull();
	});

	it("shows uncommitted IME composition without sending it to the Host", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();

		fireEvent.compositionStart(input, { data: "ㅎ" });
		fireEvent.compositionUpdate(input, { data: "한" });
		fireEvent.input(input, { target: { value: "한" } });

		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("한");
		expect(
			view.getByTestId("structured-terminal-composition").style.maxWidth,
		).toBe("calc(100% - 0px)");
		expect(
			view
				.getByTestId("structured-terminal-composition")
				.classList.contains("overflow-hidden"),
		).toBe(true);
		expect(sentRecords("inputIntent")).toHaveLength(0);

		fireEvent.compositionEnd(input, { data: "한" });
		fireEvent.input(input, { target: { value: "한" } });
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
	});

	it("paints IME composition with the authoritative cursor cell colors", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				cellForegroundRgb: 0xfafafa,
				cellBackgroundRgb: 0x333333,
			}),
		);
		const input = terminalInput(view);
		input.focus();

		fireEvent.compositionStart(input, { data: "ㅎ" });
		fireEvent.compositionUpdate(input, { data: "한" });

		const composition = view.getByTestId("structured-terminal-composition");
		expect(composition.style.color).toBe(
			"var(--terminal-cursor-cell-foreground)",
		);
		expect(composition.style.backgroundColor).toBe(
			"var(--terminal-cursor-cell-background)",
		);
		expect(
			composition.parentElement?.style.getPropertyValue(
				"--terminal-cursor-cell-foreground",
			),
		).toBe("#fafafa");
		expect(
			composition.parentElement?.style.getPropertyValue(
				"--terminal-cursor-cell-background",
			),
		).toBe("#333333");
	});

	it("keeps rapid Korean commits ordered until their exact echoes paint", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				cursorColumn: 4,
				cursorRow: 1,
				texts: ["", "x", ""],
				projectionRevision: 1n,
				throughOutputSeq: 0n,
			}),
		);
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		const committedTextRecords = () =>
			sentRecords("inputIntent").filter(
				(decoded) =>
					decoded.record.body.case === "inputIntent" &&
					decoded.record.body.value.intent.case === "text",
			);

		await act(async () => {
			fireEvent.compositionStart(input, { data: "ㅈ" });
			fireEvent.compositionUpdate(input, { data: "지" });
			fireEvent.input(input, { target: { value: "지" } });
			fireEvent.compositionEnd(input, { data: "지" });
			fireEvent.input(input, { target: { value: "지" } });
			fireEvent.compositionStart(input, { data: "ㄱ" });
			fireEvent.compositionUpdate(input, { data: "금" });
			fireEvent.input(input, { target: { value: "금" } });
			fireEvent.compositionEnd(input, { data: "금" });
			fireEvent.input(input, { target: { value: "금" } });
			fireEvent.compositionStart(input, { data: "ㄴ" });
			fireEvent.compositionUpdate(input, { data: "나" });
			fireEvent.input(input, { target: { value: "나" } });
		});

		expect(committedTextRecords()).toHaveLength(2);
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("지금나");
		expect(view.getByTestId("structured-terminal-composition").style.left).toBe(
			"40px",
		);
		const [firstCommit, secondCommit] = committedTextRecords();
		if (
			firstCommit?.record.body.case !== "inputIntent" ||
			secondCommit?.record.body.case !== "inputIntent"
		) {
			throw new Error("expected two committed text inputs");
		}

		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(firstCommit.metadata.recordId, undefined, 0n),
		);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(secondCommit.metadata.recordId, undefined, 1n),
		);
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("지금나");
		await deliverViewportFrame(onRecords[0], {
			cursorColumn: 6,
			cursorRow: 2,
			texts: ["", "", "지"],
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			inputOutputTiming: {
				inputBaselineOutputSequence: 0n,
				firstOutputSequence: 1n,
				inputToOutputMicros: 4_200n,
				outputToProjectionStartMicros: 1_500n,
				inputRecordId: firstCommit.metadata.recordId,
			},
		});
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("금나");
		expect(view.getByTestId("structured-terminal-composition").style.left).toBe(
			"60px",
		);
		await deliverViewportFrame(onRecords[0], {
			cursorColumn: 8,
			cursorRow: 2,
			texts: ["", "", "지금"],
			projectionRevision: 3n,
			throughOutputSeq: 2n,
			inputOutputTiming: {
				inputBaselineOutputSequence: 0n,
				firstOutputSequence: 1n,
				inputToOutputMicros: 4_200n,
				outputToProjectionStartMicros: 1_500n,
				inputRecordId: firstCommit.metadata.recordId,
			},
		});
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("나");
		expect(view.getByTestId("structured-terminal-composition").style.left).toBe(
			"80px",
		);

		await act(async () => {
			fireEvent.compositionEnd(input, { data: "나" });
			fireEvent.input(input, { target: { value: "나" } });
			pressEnter(input);
		});
		expect(committedTextRecords()).toHaveLength(3);
		expect(sentInputIntents("key")).toHaveLength(1);
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("나");
	});

	it("retires rapid Korean commits when one Host read coalesces their echoes", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				cursorColumn: 4,
				cursorRow: 1,
				texts: ["", "x", ""],
				projectionRevision: 1n,
				throughOutputSeq: 0n,
			}),
		);
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		const committedTextRecords = () =>
			sentRecords("inputIntent").filter(
				(decoded) =>
					decoded.record.body.case === "inputIntent" &&
					decoded.record.body.value.intent.case === "text",
			);

		await act(async () => {
			fireEvent.compositionStart(input, { data: "ㅈ" });
			fireEvent.compositionUpdate(input, { data: "지" });
			fireEvent.input(input, { target: { value: "지" } });
			fireEvent.compositionEnd(input, { data: "지" });
			fireEvent.input(input, { target: { value: "지" } });
			fireEvent.compositionStart(input, { data: "ㄱ" });
			fireEvent.compositionUpdate(input, { data: "금" });
			fireEvent.input(input, { target: { value: "금" } });
			fireEvent.compositionEnd(input, { data: "금" });
			fireEvent.input(input, { target: { value: "금" } });
			fireEvent.compositionStart(input, { data: "ㄴ" });
			fireEvent.compositionUpdate(input, { data: "나" });
			fireEvent.input(input, { target: { value: "나" } });
		});

		const [firstCommit, secondCommit] = committedTextRecords();
		if (
			firstCommit?.record.body.case !== "inputIntent" ||
			secondCommit?.record.body.case !== "inputIntent"
		) {
			throw new Error("expected two committed text inputs");
		}
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(firstCommit.metadata.recordId, undefined, 0n),
		);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(secondCommit.metadata.recordId, undefined, 0n),
		);
		await deliverViewportFrame(onRecords[0], {
			cursorColumn: 8,
			cursorRow: 2,
			texts: ["", "", "지금"],
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			inputOutputTiming: {
				inputBaselineOutputSequence: 0n,
				firstOutputSequence: 1n,
				inputToOutputMicros: 4_200n,
				outputToProjectionStartMicros: 1_500n,
				inputRecordId: firstCommit.metadata.recordId,
			},
		});

		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("나");
		expect(view.getByTestId("structured-terminal-composition").style.left).toBe(
			"80px",
		);
	});

	it("retires an echoed IME handoff before projecting the next preedit at the latest painted cursor", async () => {
		const { onRecords, view } = await bootTerminal();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				cursorColumn: 4,
				cursorRow: 1,
				texts: ["", "x", ""],
				throughOutputSeq: 0n,
			}),
		);
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		const committedTextRecords = () =>
			sentRecords("inputIntent").filter(
				(decoded) =>
					decoded.record.body.case === "inputIntent" &&
					decoded.record.body.value.intent.case === "text",
			);

		await act(async () => {
			fireEvent.compositionStart(input, { data: "ㅈ" });
			fireEvent.compositionUpdate(input, { data: "지" });
			fireEvent.input(input, { target: { value: "지" } });
			fireEvent.compositionEnd(input, { data: "지" });
			fireEvent.input(input, { target: { value: "지" } });
		});
		const [firstCommit] = committedTextRecords();
		if (
			firstCommit?.record.body.case !== "inputIntent" ||
			firstCommit.record.body.value.intent.case !== "text"
		) {
			throw new Error("expected committed text input");
		}
		expect(
			new TextDecoder().decode(firstCommit.record.body.value.intent.value.utf8),
		).toBe("지");
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("지");
		expect(view.getByTestId("structured-terminal-composition").style.left).toBe(
			"40px",
		);
		expect(view.getByTestId("structured-terminal-composition").style.top).toBe(
			"20px",
		);
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(firstCommit.metadata.recordId),
		);
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("지");
		await deliverViewportFrame(
			onRecords[0],
			{
				cursorColumn: 6,
				cursorRow: 2,
				texts: ["", "", "지"],
				projectionRevision: 2n,
				throughOutputSeq: 1n,
			},
		);
		expect(view.queryByTestId("structured-terminal-composition")).toBeNull();
		expect(input.style.left).toBe("60px");
		expect(input.style.top).toBe("40px");

		// WebKit starts the next Korean syllable in a later browser task, after
		// the Host has already painted the committed first syllable.
		await act(async () => {
			fireEvent.compositionStart(input, { data: "ㄱ" });
			fireEvent.compositionUpdate(input, { data: "금" });
			fireEvent.input(input, { target: { value: "금" } });
		});

		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("금");
		expect(view.getByTestId("structured-terminal-composition").style.left).toBe(
			"60px",
		);
		expect(view.getByTestId("structured-terminal-composition").style.top).toBe(
			"40px",
		);
		expect(input.style.left).toBe("60px");
		expect(input.style.top).toBe("40px");
		expect(committedTextRecords()).toHaveLength(1);

		await act(async () => {
			fireEvent.compositionEnd(input, { data: "금" });
			fireEvent.input(input, { target: { value: "금" } });
		});
		await waitFor(() => expect(committedTextRecords()).toHaveLength(2));
		const completed = committedTextRecords()[1];
		if (
			completed?.record.body.case !== "inputIntent" ||
			completed.record.body.value.intent.case !== "text"
		) {
			throw new Error("expected completed text input");
		}
		expect(
			new TextDecoder().decode(completed.record.body.value.intent.value.utf8),
		).toBe("금");
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(completed.metadata.recordId),
		);
		await deliverViewportFrame(
			onRecords[0],
			{
				cursorColumn: 8,
				cursorRow: 2,
				texts: ["", "", "지금"],
				projectionRevision: 3n,
				throughOutputSeq: 2n,
			},
		);
		expect(view.queryByTestId("structured-terminal-composition")).toBeNull();

		await act(async () => {
			pressEnter(input);
			fireEvent.compositionStart(input, { data: "ㄴ" });
			fireEvent.compositionUpdate(input, { data: "나" });
		});
		expect(
			view.getByTestId("structured-terminal-composition").textContent,
		).toBe("나");
	});

	it("does not commit an old IME composition into a replacement attachment", async () => {
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const replacementSeed = viewportFrameRecord({
					terminalEpoch: "terminal-b",
				});
				request.onRecord(replacementSeed.buffer as ArrayBuffer);
			}
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { terminalEpoch: "terminal-a" });
		const input = terminalInput(view);
		input.focus();
		fireEvent.compositionStart(input, { data: "ㅎ" });
		fireEvent.compositionUpdate(input, { data: "한" });

		await deliverRecord(
			onRecords[0],
			closedRecord("hmux_stream_desynchronized", "replace the attachment", "never"),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		mocks.send.mockClear();

		fireEvent.compositionEnd(input, { data: "한" });
		fireEvent.input(input, { target: { value: "한" } });
		await act(async () => Promise.resolve());
		expect(sentRecords("inputIntent")).toHaveLength(0);

		const replacementInput = terminalInput(view);
		expect(input.isConnected).toBe(false);
		expect(replacementInput.value).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(replacementInput));
		fireEvent.compositionStart(replacementInput, { data: "ㄴ" });
		fireEvent.compositionEnd(replacementInput, { data: "나" });
		fireEvent.input(replacementInput, { target: { value: "나" } });
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
	});

	it("does not continue an old replacement chain on a new attachment", async () => {
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const replacementSeed = viewportFrameRecord({
					terminalEpoch: "terminal-b",
				});
				request.onRecord(replacementSeed.buffer as ArrayBuffer);
			}
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { terminalEpoch: "terminal-a" });
		const retiredInput = terminalInput(view);
		retiredInput.focus();
		mocks.send.mockClear();
		retiredInput.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "ㅎ",
			}),
		);
		fireEvent.input(retiredInput, { target: { value: "ㅎ" } });

		const closed = new TextEncoder().encode(
			JSON.stringify({ kind: "closed", message: "replace the attachment" }),
		);
		await deliverRecord(onRecords[0], closed);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		mocks.send.mockClear();

		retiredInput.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertReplacementText",
				data: "하",
			}),
		);
		fireEvent.input(retiredInput, { target: { value: "하" } });
		await act(async () => Promise.resolve());
		expect(sentRecords("inputIntent")).toHaveLength(0);

		const currentInput = terminalInput(view);
		await waitFor(() => expect(document.activeElement).toBe(currentInput));
		currentInput.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "나",
			}),
		);
		fireEvent.input(currentInput, { target: { value: "나" } });
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
	});

	it("dismisses an oversized paste notice without replaying input or replacing the attachment", async () => {
		mocks.readClipboardImage.mockResolvedValue(null);
		mocks.readClipboardText.mockResolvedValue("");
		const onRecords = installAttachMock();
		const resume = vi.fn(async () => {});
		const view = renderTerminalView({
			attachRecovery: {
				ownerKey: "fixture-runtime",
				intent: "resume",
				resume,
				automatic: true,
				context: "pane-a",
			},
		});
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		const pasteOversizedText = () =>
			fireEvent.paste(input, {
				clipboardData: { items: [], getData: () => "x".repeat(64 * 1024 + 1) },
			});

		pasteOversizedText();
		await waitFor(() => {
			expect(view.getByRole("alert").textContent).toContain("paste input is oversized");
		});
		expect(sentInputIntents("paste")).toHaveLength(0);
		fireEvent.click(
			view.getByRole("button", { name: t("terminal.recovery.copyDetails") }),
		);
		await waitFor(() => {
			expect(mocks.writeClipboard).toHaveBeenCalledWith(
				"TerminalStateProtocolError: paste input is oversized",
			);
		});
		fireEvent.click(view.getByRole("button", { name: t("common.close") }));
		expect(view.queryByRole("alert")).toBeNull();
		expect(mocks.send).not.toHaveBeenCalled();
		expect(input.disabled).toBe(false);

		fireEvent.paste(input, {
			clipboardData: { items: [], getData: () => "small paste" },
		});
		await waitFor(() => expect(sentInputIntents("paste")).toHaveLength(1));
		const [accepted] = sentInputIntents("paste");
		if (!accepted) throw new Error("paste missing");
		await deliverRecord(onRecords[0], inputReceiptRecord(accepted.metadata.recordId));
		await deliverViewportFrame(onRecords[0], { projectionRevision: 2n });
		expect(view.queryByRole("alert")).toBeNull();

		pasteOversizedText();
		await waitFor(() => {
			expect(view.getByRole("alert").textContent).toContain("paste input is oversized");
		});
		expect(sentInputIntents("paste")).toHaveLength(1);
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
		expect(resume).not.toHaveBeenCalled();
	});

	it("saves a native clipboard image and pastes its path through the Host", async () => {
		const onRecords = installAttachMock();
		mocks.readClipboardImage.mockResolvedValue({
			dataB64: "aW1hZ2U=",
			ext: "png",
		});
		mocks.saveTempFiles.mockResolvedValue(["/tmp/dure-paste.png"]);
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(onRecords[0], viewportFrameRecord());
		const input = terminalInput(view);

		fireEvent.paste(input, {
			clipboardData: {
				items: [],
				getData: () => "",
			},
		});

		await waitFor(() =>
			expect(mocks.saveTempFiles).toHaveBeenCalledWith([
				{
					dataB64: "aW1hZ2U=",
					fileName: "pasted-image.png",
				},
			]),
		);
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		const decoded = sentRecords("inputIntent")[0];
		if (!decoded) throw new Error("record");
		if (decoded.record.body.case !== "inputIntent") throw new Error("input");
		const intent = decoded.record.body.value.intent;
		if (intent.case !== "paste") throw new Error("paste");
		expect(new TextDecoder().decode(intent.value.utf8)).toBe(
			"'/tmp/dure-paste.png' ",
		);
	});

	it.each([false, true])(
		"uploads a remote clipboard image without retargeting a replaced attachment (%s)",
		async (replaceAttachment) => {
			let finishUpload!: (paths: string[]) => void;
			mocks.readClipboardImage.mockResolvedValue({
				dataB64: "aW1hZ2U=",
				ext: "png",
			});
			mocks.uploadSshFilesToTemp.mockReturnValue(
				new Promise((resolve) => {
					finishUpload = resolve;
				}),
			);
			const onRecords = installAttachMock();
			const view = render(
				<StructuredTerminalView
					sessionId="standalone_source"
					surfaceId="pane-remote"
					binding={remoteHmuxStandaloneBinding(
						"standalone_source",
						"workspace_source",
						"host-rts",
						"bridge_nonce",
					)}
				/>,
			);
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);
			mocks.send.mockClear();
			fireEvent.paste(terminalInput(view), {
				clipboardData: { items: [], getData: () => "" },
			});
			await waitFor(() =>
				expect(mocks.uploadSshFilesToTemp).toHaveBeenCalledOnce(),
			);
			expect(mocks.uploadSshFilesToTemp).toHaveBeenCalledWith(
				{
					host: "rts.example.com",
					port: 22,
					user: "rts",
					auth: "auto",
					hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
				},
				[{ fileName: "pasted-image.png", dataB64: "aW1hZ2U=" }],
			);
			expect(mocks.saveTempImage).not.toHaveBeenCalled();
			expect(mocks.saveTempFiles).not.toHaveBeenCalled();
			expect(sentInputIntents("paste")).toHaveLength(0);
			if (replaceAttachment) {
				view.rerender(terminalElement("session-b"));
				await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
				await deliverViewportFrame(onRecords[1]);
				mocks.send.mockClear();
			}
			await act(async () =>
				finishUpload(["/tmp/dure-drop.aB123z/pasted-image.png"]),
			);
			await waitFor(() =>
				expect(sentInputIntents("paste")).toHaveLength(replaceAttachment ? 0 : 1),
			);
			if (!replaceAttachment) {
				const [pasted] = sentInputIntents("paste");
				if (
					pasted?.record.body.case !== "inputIntent" ||
					pasted.record.body.value.intent.case !== "paste"
				)
					throw new Error("expected paste");
				expect(
					new TextDecoder().decode(pasted.record.body.value.intent.value.utf8),
				).toBe("'/tmp/dure-drop.aB123z/pasted-image.png' ");
			}
		},
	);

	it("attributes asynchronous paste resolution to the paste input boundary", async () => {
		let resolveClipboardText!: (text: string) => void;
		mocks.readClipboardImage.mockResolvedValue(null);
		mocks.readClipboardText.mockReturnValue(
			new Promise((resolve) => {
				resolveClipboardText = resolve;
			}),
		);
		const { onRecords, view } = await bootTerminalWithFrame({
			projectionRevision: 7n,
			stateRevision: 9n,
			throughOutputSeq: 11n,
		});
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();
		let now = performance.now() - 300;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);

		fireEvent.keyDown(input, {
			key: "v",
			code: "KeyV",
			metaKey: true,
		});
		fireEvent.paste(input, {
			clipboardData: { items: [], getData: () => "" },
		});
		expect(sentInputIntents("paste")).toHaveLength(0);

		now += 300;
		try {
			await act(async () => resolveClipboardText("pasted text"));
		} finally {
			nowSpy.mockRestore();
		}
		await waitFor(() => expect(sentInputIntents("paste")).toHaveLength(1));
		const [sent] = sentInputIntents("paste");
		expect(sent).toBeDefined();
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(sent?.metadata.recordId ?? 0n),
		);
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 8n,
			stateRevision: 10n,
			throughOutputSeq: 12n,
			inputOutputTiming: {
				inputBaselineOutputSequence: 11n,
				firstOutputSequence: 12n,
				inputToOutputMicros: 4_200n,
				outputToProjectionStartMicros: 1_500n,
				inputRecordId: sent?.metadata.recordId ?? 0n,
			},
		});
		await flushFrames();

		await waitFor(() =>
			expect(terminalInputLatency.snapshot()).toMatchObject({
				inFlightCount: 0,
				samples: [
					{
						dispatchMs: 300,
						outcome: "complete",
						source: "input",
						terminalId: "pane-a",
					},
				],
			}),
		);
	});

	it("does not retarget an asynchronous image paste to a replacement attachment", async () => {
		let resolveSavedPath!: (paths: string[]) => void;
		const onRecords = installAttachMock((attach) => ({
			terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b",
		}));
		mocks.readClipboardImage.mockResolvedValue({
			dataB64: "aW1hZ2U=",
			ext: "png",
		});
		mocks.saveTempFiles.mockResolvedValue(["/tmp/local-staging.png"]);
		mocks.routeSessionFiles.mockReturnValue(
			new Promise((resolve) => {
				resolveSavedPath = resolve;
			}),
		);
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await act(async () => {
			const seed = viewportFrameRecord({ terminalEpoch: "terminal-a" });
			onRecords[0]?.(seed.buffer as ArrayBuffer);
		});
		fireEvent.paste(terminalInput(view), {
			clipboardData: { items: [], getData: () => "" },
		});
		await waitFor(() => expect(mocks.routeSessionFiles).toHaveBeenCalledOnce());

		view.rerender(terminalElement("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		await deliverRecord(
			onRecords[1],
			viewportFrameRecord({ terminalEpoch: "terminal-b" }),
		);
		mocks.send.mockClear();

		await act(async () => resolveSavedPath(["/tmp/old-attachment.png"]));

		expect(sentRecords("inputIntent")).toHaveLength(0);
	});

	it.each([false, true])(
		"routes a local pane image through its SSH process and rejects a changed route (%s)",
		async (routeChanged) => {
			const { view } = await bootTerminalWithFrame();
			mocks.readClipboardImage.mockResolvedValue({
				dataB64: "aW1hZ2U=",
				ext: "png",
			});
			mocks.saveTempFiles.mockResolvedValue(["/tmp/mac/pasted-image.png"]);
			if (routeChanged)
				mocks.routeSessionFiles.mockRejectedValue(
					new Error("session_file_ssh_changed"),
				);
			else
				mocks.routeSessionFiles.mockResolvedValue([
					"/tmp/hmux-paste.aB123z/0-pasted-image.png",
				]);
			mocks.send.mockClear();
			fireEvent.paste(terminalInput(view), {
				clipboardData: { items: [], getData: () => "" },
			});
			await waitFor(() =>
				expect(mocks.routeSessionFiles).toHaveBeenCalledOnce(),
			);
			expect(mocks.routeSessionFiles).toHaveBeenCalledWith({
				sessionId: "session-a",
				workspaceId: "workspace-a",
				terminalEpoch: "terminal-a",
				paths: ["/tmp/mac/pasted-image.png"],
			});
			if (routeChanged) {
				await waitFor(() =>
					expect(view.getByRole("alert").textContent).toContain(
						t("files.transfer.sessionChanged"),
					),
				);
				expect(sentInputIntents("paste")).toHaveLength(0);
			} else {
				await waitFor(() => expect(sentInputIntents("paste")).toHaveLength(1));
				const record = sentInputIntents("paste")[0];
				if (
					record?.record.body.case !== "inputIntent" ||
					record.record.body.value.intent.case !== "paste"
				)
					throw new Error("paste missing");
				expect(
					new TextDecoder().decode(record.record.body.value.intent.value.utf8),
				).toBe("'/tmp/hmux-paste.aB123z/0-pasted-image.png' ");
			}
		},
	);
});

describe("terminal editing chords and external file drop", () => {
	it("sends the catalog control sequence for the terminal editing chords", async () => {
		const { view } = await bootTerminalWithFrame();
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();

		fireEvent.keyDown(input, {
			key: "Backspace",
			code: "Backspace",
			metaKey: true,
		});
		fireEvent.keyDown(input, {
			key: "ArrowLeft",
			code: "ArrowLeft",
			metaKey: true,
		});
		fireEvent.keyDown(input, {
			key: "ArrowRight",
			code: "ArrowRight",
			metaKey: true,
		});
		fireEvent.keyDown(input, {
			key: "Backspace",
			code: "Backspace",
			altKey: true,
		});

		await waitFor(() => expect(sentTextPayloads()).toHaveLength(4));
		expect(sentTextPayloads()).toEqual(["\x15", "\x01", "\x05", "\x17"]);
		expect(sentInputIntents("key")).toHaveLength(0);
	});

	it("leaves Ctrl chords with the terminal instead of the editing bindings", async () => {
		const { view } = await bootTerminalWithFrame();
		const input = terminalInput(view);
		input.focus();
		mocks.send.mockClear();

		fireEvent.keyDown(input, {
			key: "Backspace",
			code: "Backspace",
			ctrlKey: true,
		});

		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		expect(sentTextPayloads()).toHaveLength(0);
	});

	it("saves an external file drop and pastes the prepared path once", async () => {
		mocks.saveTempFiles.mockResolvedValue([
			"/tmp/dure-drop/it's a note.txt",
		]);
		const { view } = await bootTerminalWithFrame();
		mocks.send.mockClear();

		const host = view.getByTestId("structured-host");
		const dataTransfer = {
			types: ["Files"],
			files: {
				length: 1,
				0: {
					name: "it's a note.txt",
					size: 2,
					arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
				},
			},
		};
		fireEvent.dragOver(host, { dataTransfer });
		await act(async () => {
			fireEvent.drop(host, { dataTransfer });
		});

		await waitFor(() => expect(mocks.saveTempFiles).toHaveBeenCalledOnce());
		expect(mocks.saveTempFiles.mock.calls[0]?.[0]).toEqual([
			{ fileName: "it's a note.txt", dataB64: "aGk=" },
		]);
		await waitFor(() => expect(sentInputIntents("paste")).toHaveLength(1));
		const [pasted] = sentInputIntents("paste");
		if (
			pasted?.record.body.case !== "inputIntent" ||
			pasted.record.body.value.intent.case !== "paste"
		) {
			throw new Error("expected a structured paste input intent");
		}
		expect(
			new TextDecoder().decode(pasted.record.body.value.intent.value.utf8),
		).toBe("'/tmp/dure-drop/it'\\''s a note.txt' ");
	});

	it("uploads a remote pane's drop to the host and pastes the remote paths", async () => {
		mocks.uploadSshFilesToTemp.mockResolvedValue([
			"/tmp/dure-drop.aB123z/note.txt",
		]);
		const onRecords = installAttachMock();
		const view = render(
			<StructuredTerminalView
				sessionId="standalone_source"
				surfaceId="pane-remote"
				binding={remoteHmuxStandaloneBinding(
					"standalone_source",
					"workspace_source",
					"host-rts",
					"bridge_nonce",
				)}
			/>,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		mocks.send.mockClear();

		await act(async () => {
			fireEvent.drop(view.getByTestId("structured-host"), {
				dataTransfer: {
					types: ["Files"],
					files: {
						length: 1,
						0: {
							name: "note.txt",
							size: 2,
							arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
						},
					},
				},
			});
		});

		await waitFor(() =>
			expect(mocks.uploadSshFilesToTemp).toHaveBeenCalledOnce(),
		);
		// The host is resolved at drop time from the pane's binding, never from
		// a local temp save that the remote shell could not open.
		expect(mocks.uploadSshFilesToTemp.mock.calls[0]?.[0]).toEqual({
			host: "rts.example.com",
			port: 22,
			user: "rts",
			auth: "auto",
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		});
		expect(mocks.saveTempFiles).not.toHaveBeenCalled();
		await waitFor(() => expect(sentInputIntents("paste")).toHaveLength(1));
		const [pasted] = sentInputIntents("paste");
		if (
			pasted?.record.body.case !== "inputIntent" ||
			pasted.record.body.value.intent.case !== "paste"
		) {
			throw new Error("expected a structured paste input intent");
		}
		expect(
			new TextDecoder().decode(pasted.record.body.value.intent.value.utf8),
		).toBe("'/tmp/dure-drop.aB123z/note.txt' ");
	});

	it("raises the pane through dockview's own receiver on drop", async () => {
		// dockview's setActive reads `this.accessor`, so a bare
		// `paneApi.setActive` reference throws the moment a file lands and takes
		// the whole drop with it. This stand-in fails the same way.
		const activated: string[] = [];
		const disposable = { dispose: () => {} };
		const subscribe = () => disposable;
		const paneApi = {
			accessor: "dockview",
			isActive: true,
			isVisible: true,
			isGroupActive: true,
			group: { api: { onWillFocus: subscribe } },
			onDidGroupChange: subscribe,
			onDidActiveChange: subscribe,
			onDidVisibilityChange: subscribe,
			onDidActiveGroupChange: subscribe,
			setActive(this: { accessor?: string } | undefined) {
				if (!this?.accessor) {
					throw new TypeError(
						"undefined is not an object (evaluating 'this.accessor')",
					);
				}
				activated.push(this.accessor);
			},
		};
		mocks.saveTempFiles.mockResolvedValue(["/tmp/dure-drop/note.txt"]);
		const onRecords = installAttachMock();
		const view = render(
			<StructuredTerminalView
				sessionId="session-a"
				surfaceId="pane-a"
				binding={hmuxPaneBinding("session-a")}
				paneApi={
					paneApi as unknown as ComponentProps<
						typeof StructuredTerminalView
					>["paneApi"]
				}
			/>,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		mocks.send.mockClear();

		await act(async () => {
			fireEvent.drop(view.getByTestId("structured-host"), {
				dataTransfer: {
					types: ["Files"],
					files: {
						length: 1,
						0: {
							name: "note.txt",
							size: 2,
							arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
						},
					},
				},
			});
		});

		expect(activated).toEqual(["dockview"]);
		await waitFor(() => expect(mocks.saveTempFiles).toHaveBeenCalledOnce());
		await waitFor(() => expect(sentInputIntents("paste")).toHaveLength(1));
	});

	it("leaves an app-internal pane drag to dockview", async () => {
		const { view } = await bootTerminalWithFrame();
		mocks.send.mockClear();

		const host = view.getByTestId("structured-host");
		await act(async () => {
			fireEvent.drop(host, {
				dataTransfer: {
					types: ["application/x-dure-pane"],
					files: { length: 0 },
				},
			});
		});

		expect(mocks.saveTempFiles).not.toHaveBeenCalled();
		expect(sentInputIntents("paste")).toHaveLength(0);
	});
});
