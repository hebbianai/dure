/**
 * Shared harness for the StructuredTerminalView suites
 * (attach / resize / input / wheelSelection / presentation): the shared mock
 * state (`mocks`, `protocolMocks`), the factory bodies for every vi.mock'd
 * module, the attach/pull plumbing, the controlled ResizeObserver/raf
 * environment, DOM helpers, and the per-test reset logic. `vi.mock` only
 * takes effect in the test file itself (hoisting), so each suite keeps thin
 * `vi.mock("<module>", async () => (await import("./structuredTerminalTestHarness")).xxxFactory())`
 * lines while the bodies live here. Those factories run when the mocked
 * module is first imported, so this harness must never import
 * `StructuredTerminalView` (or anything else that transitively imports a
 * mocked module) — each suite imports the component itself and registers it
 * via `registerStructuredTerminalView`. The one exception is
 * `@/lib/terminal/protocol/terminalStateProtocol`, which this harness imports
 * (directly and via the record fixtures): its mock factory would fire while
 * the harness is still evaluating, so each suite keeps that factory inline,
 * touching `protocolMocks` only lazily from inside the decode wrapper.
 */
import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { expect, vi } from "vitest";
import { planRemoteHmuxCatalogTarget } from "@/lib/hmux/remote/remoteHmuxBroker";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { createSessionRuntimeStoreSlice } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { StructuredTerminalRecoveryAdmission } from "@/lib/terminal/structuredTerminalRecoveryAdmission";
import type {
	TerminalWindowFocusProbe,
	TerminalWindowFocusProbeSurface,
} from "@/lib/terminal/terminalWindowFocusProbe";
import { installSashDragHighlight } from "@/lib/ui/sashDragHighlight";
import {
	hmuxPaneBinding as binding,
	resizeAppliedReceiptRecord,
	type ViewportFrameRecordOptions,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import type { SshHostConfig } from "@/types";
import type { StructuredTerminalView } from "./StructuredTerminalView";
import { mocks, protocolMocks } from "./structuredTerminalHarnessMocks";

export { mocks, protocolMocks };

/** Factory body for vi.mock("@/components/workspace/WorkspaceRuntimeContext"). */
export function workspaceRuntimeContextMockFactory() {
	return {
		useWorkspaceRuntimeDesktopId: () => mocks.desktopId,
		useWorkspaceRuntimeActive: () => mocks.workspaceActive,
		useWorkspaceTerminalRecoveryAdmission: () => mocks.recoveryAdmission,
	};
}

/** Factory body for vi.mock("@/lib/workspace/window/largeViewReturnSourceRuntime"). */
export function largeViewReturnSourceRuntimeMockFactory() {
	return {
		bindLargeViewReturnSource: mocks.bindLargeViewReturnSource,
	};
}

/** Factory body for vi.mock("@/lib/workspace/window/currentWindowFocus"). */
export function currentWindowFocusMockFactory() {
	return {
		currentWindowIsFocused: () => mocks.windowFocused,
		currentWindowIsInputReady: () => mocks.windowFocused,
		subscribeCurrentWindowInputReady: (listener: (ready: boolean) => void) => {
			mocks.windowFocusListeners.add(listener);
			listener(mocks.windowFocused);
			return () => mocks.windowFocusListeners.delete(listener);
		},
		subscribeCurrentWindowFocus: (listener: (focused: boolean) => void) => {
			mocks.windowFocusListeners.add(listener);
			listener(mocks.windowFocused);
			return () => mocks.windowFocusListeners.delete(listener);
		},
	};
}

/** Factory body for vi.mock("@/lib/ipc"). */
export function ipcMockFactory() {
	return {
		readClipboardImage: mocks.readClipboardImage,
		routeSessionFiles: mocks.routeSessionFiles,
		remoteHmuxCatalog: mocks.remoteCatalog,
		remoteHmuxKnownHostTrust: mocks.remoteKnownHostTrust,
		prepareTrustedSshTarget: async (hosts: readonly SshHostConfig[], hostId: string) =>
			planRemoteHmuxCatalogTarget(hosts, hostId, await mocks.remoteKnownHostTrust(hostId)),
		saveTempImage: mocks.saveTempImage, saveTempFiles: mocks.saveTempFiles, uploadSshFilesToTempDirectory: mocks.uploadSshFilesToTemp, hostToOpts: (host: { host: string; user: string }) => ({ host: host.host, user: host.user }),
		hmux: {
			attachStructuredTerminal: (request: { observerId: string }) =>
				adaptPulledAttach(request),
			attachRemoteStructuredTerminal: (request: { observerId: string }) =>
				adaptPulledAttach(request),
			nextStructuredTerminalRecord: (observerId: string) =>
				nextPulledRecord(observerId),
			detachStructuredTerminal: async (observerId: string) => {
				retirePulledRecords(observerId);
				return mocks.detach(observerId);
			},
			sendStructuredTerminalRecord: mocks.send,
		},
	};
}

/** Factory body for vi.mock("@/store"). */
export function storeMockFactory() {
	const runtimeSlice = createSessionRuntimeStoreSlice((updater) => {
		const next = updater(state);
		if (next !== state) Object.assign(state, next);
	});
	const state = {
		...runtimeSlice,
		sshStates: {},
		sshMessages: {},
		activeSpaceId: "structured-focus-desktop",
		agents: [],
		customThemes: [],
		notifyPrefs: {},
		sshHosts: [
			{
				id: "host-rts",
				name: "RTS",
				host: "rts.example.com",
				port: 22,
				user: "rts",
				auth: "auto",
			},
		],
		sessionAgent: {},
		sessionAgentPin: {},
		sessionTitle: {},
		setHmuxSessionMetadata: mocks.setHmuxSessionMetadata,
		setSessionAgent: mocks.setSessionAgent,
		setSessionAgentPin: mocks.setSessionAgentPin,
		setSessionAgentRuntimeState: mocks.setSessionAgentRuntimeState,
		beginSessionAgentRuntimeObservation: (sessionId: string) => {
			const observation =
				runtimeSlice.beginSessionAgentRuntimeObservation(sessionId);
			return {
				publish: (runtime: HmuxAgentRuntimeState) => {
					mocks.setSessionAgentRuntimeState(sessionId, runtime);
					observation.publish(runtime);
				},
				dispose: observation.dispose,
			};
		},
		setSessionCwd: mocks.setSessionCwd,
		setSessionTitle: mocks.setSessionTitle,
		get terminalFontSize() {
			return mocks.terminalFontSize;
		},
		terminalPrefs: { copyOnSelect: true, osc52: true }, shortcutOverrides: {},
		uiPrefs: { terminalFontFamily: "", get terminalLineHeight() { return mocks.terminalLineHeight; } },
	};
	return {
		useStore: Object.assign(
			(selector: (candidate: unknown) => unknown) => selector(state),
			{ getState: () => state },
		),
	};
}

/** Factory body for vi.mock("@tauri-apps/plugin-clipboard-manager"). */
export function clipboardManagerMockFactory() {
	return {
		readText: mocks.readClipboardText,
		writeText: mocks.writeClipboard,
	};
}

/** Factory body for vi.mock("@/lib/toast"). */
export function toastMockFactory() {
	return {
		showToast: mocks.showToast,
	};
}

/** Factory body for vi.mock("@/components/terminal/TerminalViewChrome"). */
export function terminalViewChromeMockFactory() {
	return {
		TerminalViewChrome: ({
			containerRef,
			containerClassName,
			children,
		}: {
			containerRef: RefObject<HTMLDivElement | null>;
			containerClassName?: string;
			children: ReactNode;
		}) => (
			<div
				ref={containerRef}
				data-testid="structured-host"
				className={containerClassName}
			>
				{children}
			</div>
		),
	};
}

/** Factory body for vi.mock("./TerminalCanvasRenderer"). */
export function terminalCanvasRendererMockFactory() {
	return {
		createTerminalCanvasRenderer: () => ({
			invalidateMetrics: mocks.invalidateMetrics,
			measure: mocks.measure,
		}),
	};
}

export async function adaptPulledAttach(request: { observerId: string }) {
	let deliveredBeforeReceipt = 0;
	let receiptResolved = false;
	const receipt = await mocks.attach({
		...request,
		onRecord: (record: ArrayBuffer) => {
			if (!receiptResolved) deliveredBeforeReceipt += 1;
			deliverPulledRecord(request.observerId, record);
		},
	});
	receiptResolved = true;
	let initialDeliveryRecordCount = Math.max(
		receipt.initialDeliveryRecordCount ?? 0,
		deliveredBeforeReceipt,
	);
	for (const record of [
		receipt.agentIdentity
			? { kind: "agent_identity", identity: receipt.agentIdentity }
			: undefined,
		receipt.agentRuntimeState
			? { kind: "agent_runtime_state", state: receipt.agentRuntimeState }
			: undefined,
		receipt.providerConversationIdentity
			? {
					kind: "provider_conversation_identity",
					identity: receipt.providerConversationIdentity,
				}
			: undefined,
	]) {
		if (!record) continue;
		const encoded = new TextEncoder().encode(JSON.stringify(record));
		deliverPulledRecord(request.observerId, encoded.buffer as ArrayBuffer);
		initialDeliveryRecordCount += 1;
	}
	return { ...receipt, initialDeliveryRecordCount };
}

export function deliverPulledRecord(
	observerId: string,
	record: ArrayBuffer,
): void {
	const waiter = mocks.pullWaiters.get(observerId)?.shift();
	if (waiter) {
		waiter.resolve(record);
		return;
	}
	const queued = mocks.pullRecords.get(observerId) ?? [];
	queued.push(record);
	mocks.pullRecords.set(observerId, queued);
}

export function nextPulledRecord(observerId: string): Promise<ArrayBuffer> {
	const queued = mocks.pullRecords.get(observerId);
	const record = queued?.shift();
	if (record) return Promise.resolve(record);
	return new Promise((resolve, reject) => {
		const waiters = mocks.pullWaiters.get(observerId) ?? [];
		waiters.push({ resolve, reject });
		mocks.pullWaiters.set(observerId, waiters);
	});
}

export function retirePulledRecords(observerId: string): void {
	const waiters = mocks.pullWaiters.get(observerId) ?? [];
	for (const waiter of waiters) waiter.reject(new Error("pull retired"));
	mocks.pullWaiters.delete(observerId);
	mocks.pullRecords.delete(observerId);
}

export interface ControlledResizeObserver {
	readonly callback: ResizeObserverCallback;
	readonly targets: Element[];
}

export const resizeObservers: ControlledResizeObserver[] = [];
let nextFrame = 1;
let nextUuid = 1;
export const frames = new Map<number, FrameRequestCallback>();
let restoreDocumentFonts = () => {};

/**
 * Registers the undo for a `document.fonts` override so the shared afterEach
 * can restore it. Used by the presentation suite's loading-font-set installer.
 */
export function registerDocumentFontsRestore(restore: () => void): void {
	restoreDocumentFonts = restore;
}

export interface CanvasPresentationProbe {
	readonly surface: HTMLDivElement;
	readonly layer: HTMLDivElement;
	readonly rect: () => DOMRect;
}

export function installCanvasPresentationProbe(
	container: HTMLElement,
	hostSize: () => { readonly width: number; readonly height: number },
): CanvasPresentationProbe {
	const surface = terminalViewport(container);
	const layer = container.querySelector(
		'[data-testid="structured-terminal-presentation"]',
	);
	if (!(layer instanceof HTMLDivElement)) {
		throw new Error("structured terminal presentation layer is missing");
	}
	const explicitPixels = (value: string): number | undefined => {
		if (!value.endsWith("px")) return undefined;
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const rect = (): DOMRect => {
		const host = hostSize();
		const width = explicitPixels(layer.style.width) ?? host.width;
		const height = explicitPixels(layer.style.height) ?? host.height;
		const tailAnchored = layer.style.bottom === "0px";
		const top = tailAnchored ? host.height - height : 0;
		return {
			bottom: top + height,
			height,
			left: 0,
			right: width,
			top,
			width,
			x: 0,
			y: top,
			toJSON: () => ({}),
		};
	};
	vi.spyOn(surface, "getBoundingClientRect").mockImplementation(rect);
	return { surface, layer, rect };
}

export function sentRecords(bodyCase: string) {
	return (mocks.send.mock.calls as [string, Uint8Array][])
		.map(([, encoded]) => decodeTerminalStateRecord(encoded))
		.filter(({ record }) => record.body.case === bodyCase);
}

export function sentInputIntents(intentCase: string) {
	return sentRecords("inputIntent").filter(
		({ record }) =>
			record.body.case === "inputIntent" &&
			record.body.value.intent.case === intentCase,
	);
}

export function visibleTerminalText(container: HTMLElement): string {
	return [...container.querySelectorAll<HTMLElement>(".term-row")]
		.map((row) => row.textContent?.trimEnd() ?? "")
		.join("\n");
}

export function terminalViewport(container: HTMLElement): HTMLDivElement {
	const viewport = container.querySelector(
		'[data-testid="structured-terminal-viewport"]',
	);
	if (!(viewport instanceof HTMLDivElement)) {
		throw new Error("structured terminal viewport is missing");
	}
	return viewport;
}

export function selectTerminalViewportText(viewport: HTMLDivElement): string {
	const row = viewport.querySelector<HTMLElement>(".term-row");
	if (!row) throw new Error("structured terminal row is missing");
	const range = document.createRange();
	range.selectNodeContents(row);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	return selection?.toString().trimEnd() ?? "";
}

export function pointerEvent(type: string): Event {
	const event = new MouseEvent(type, { bubbles: true, button: 0 });
	Object.defineProperty(event, "pointerId", { value: 19 });
	return event;
}

export async function flushFrames(): Promise<void> {
	const pending = [...frames.entries()];
	frames.clear();
	await act(async () => {
		for (const [, callback] of pending) callback(performance.now());
	});
}

export function semanticResizeCalls(): Array<{
	readonly observerId: string;
	readonly columns: number;
	readonly rows: number;
}> {
	return mocks.send.mock.calls.flatMap(([observerId, encoded]) => {
		const decoded = decodeTerminalStateRecord(encoded as Uint8Array);
		if (
			decoded.record.body.case !== "inputIntent" ||
			decoded.record.body.value.intent.case !== "resize"
		) {
			return [];
		}
		return [
			{
				observerId: observerId as string,
				columns: decoded.record.body.value.intent.value.columns,
				rows: decoded.record.body.value.intent.value.rows,
			},
		];
	});
}

export interface StructuredAttachRequest {
	readonly sessionId?: string;
	onRecord(record: ArrayBuffer): void;
}

export type StructuredAttachPlan = (
	attach: number,
	request: StructuredAttachRequest,
) => Record<string, unknown> | Promise<unknown> | undefined;

/**
 * Installs the standard structured attach mock. Every attach appends its
 * carrier callback to the returned list (in attach order). `plan` receives
 * the 1-based attach ordinal plus the request and may return receipt field
 * overrides (merged over the standard terminal-a receipt) or a Promise that
 * takes over that attach attempt entirely.
 */
export function installAttachMock(
	plan?: StructuredAttachPlan,
): Array<(record: ArrayBuffer) => void> {
	const onRecords: Array<(record: ArrayBuffer) => void> = [];
	mocks.attach.mockImplementation((request: StructuredAttachRequest) => {
		onRecords.push(request.onRecord);
		const planned = plan?.(onRecords.length, request);
		if (planned instanceof Promise) return planned;
		return Promise.resolve({
			terminalEpoch: "terminal-a",
			throughOutputSeq: "0",
			stateRevision: "1",
			...planned,
		});
	});
	return onRecords;
}

/** Standard attach receipt for terminal-a, with optional field overrides. */
export function attachReceipt(overrides: Record<string, unknown> = {}) {
	return {
		terminalEpoch: "terminal-a",
		throughOutputSeq: "0",
		stateRevision: "1",
		...overrides,
	};
}

/**
 * Installs the standard attach mock but holds the `at`-th attach receipt
 * until the returned `resolveAttach` runs (with optional receipt overrides).
 * Other attach ordinals fall through to `plan`.
 */
export function installDeferredAttachMock(at = 1, plan?: StructuredAttachPlan) {
	let resolve!: (receipt: Record<string, unknown>) => void;
	const onRecords = installAttachMock((attach, request) =>
		attach === at
			? new Promise<Record<string, unknown>>((settle) => {
					resolve = settle;
				})
			: plan?.(attach, request),
	);
	return {
		onRecords,
		resolveAttach: (overrides: Record<string, unknown> = {}) =>
			resolve(attachReceipt(overrides)),
	};
}

type StructuredTerminalViewComponent = typeof StructuredTerminalView;

let registeredView: StructuredTerminalViewComponent | undefined;

/**
 * Registers the component under test. The harness cannot import
 * StructuredTerminalView itself — that import would load the vi.mock'd
 * modules while this module is still evaluating, before the suites' thin
 * factory wrappers can reach the harness. Each suite imports the component
 * and calls this once at module scope.
 */
export function registerStructuredTerminalView(
	component: StructuredTerminalViewComponent,
): void {
	registeredView = component;
}

function structuredTerminalViewComponent(): StructuredTerminalViewComponent {
	if (!registeredView) {
		throw new Error(
			"registerStructuredTerminalView(StructuredTerminalView) must run at suite module scope before rendering",
		);
	}
	return registeredView;
}

/** Renders the view under test with the standard session/surface/binding. */
export function renderTerminalView(
	props: Partial<ComponentProps<typeof StructuredTerminalView>> = {},
) {
	const View = structuredTerminalViewComponent();
	const sessionId = props.sessionId ?? "session-a";
	return render(
		<View
			sessionId={sessionId}
			surfaceId="pane-a"
			binding={binding(sessionId)}
			{...props}
		/>,
	);
}

/** Pins the structured host's client geometry; getters stay live. */
export function sizeStructuredHost(
	view: { getByTestId(id: string): HTMLElement },
	width: number | (() => number),
	height: number | (() => number),
): HTMLElement {
	const host = view.getByTestId("structured-host");
	Object.defineProperty(host, "clientWidth", {
		get: () => Math.round(typeof width === "function" ? width() : width),
	});
	Object.defineProperty(host, "clientHeight", {
		get: () => Math.round(typeof height === "function" ? height() : height),
	});
	vi.spyOn(host, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(
			0,
			0,
			typeof width === "function" ? width() : width,
			typeof height === "function" ? height() : height,
		),
	);
	return host;
}

/** Delivers one encoded record through a captured carrier inside act(). */
export async function deliverRecord(
	onRecord: ((record: ArrayBuffer) => void) | undefined,
	record: Uint8Array,
): Promise<void> {
	await act(async () => {
		onRecord?.(record.buffer as ArrayBuffer);
	});
}

/** Delivers one viewport frame, then flushes the scheduled paint frames. */
export async function deliverViewportFrame(
	onRecord: ((record: ArrayBuffer) => void) | undefined,
	options: ViewportFrameRecordOptions = {},
): Promise<void> {
	await deliverRecord(onRecord, viewportFrameRecord(options));
	await flushFrames();
}

/** The pane element for the standard surface and binding of a session. */
export function terminalElement(sessionId: string) {
	const View = structuredTerminalViewComponent();
	return (
		<View
			sessionId={sessionId}
			surfaceId="pane-a"
			binding={binding(sessionId)}
		/>
	);
}

/** The terminal's hidden textarea input inside a rendered view. */
export function terminalInput(view: {
	getByRole(role: string, options: { name: string }): HTMLElement;
}): HTMLTextAreaElement {
	return view.getByRole("textbox", {
		name: t("terminal.input.ariaLabel"),
	}) as HTMLTextAreaElement;
}

/** Presses Enter on the target the way a physical keydown would. */
export function pressEnter(target: Element): void {
	fireEvent.keyDown(target, { key: "Enter", code: "Enter" });
}

export function structuredObserverId(ordinal: number): string {
	const request = mocks.attach.mock.calls[ordinal - 1]?.[0];
	if (!request) throw new Error(`Attachment ${ordinal} has not started`);
	return request.observerId;
}

/** Asserts the send log holds exactly one semantic resize with this grid. */
export function expectSingleSemanticResize(
	columns: number,
	rows: number,
	ordinal = 1,
): void {
	expect(semanticResizeCalls()).toEqual([
		{ observerId: structuredObserverId(ordinal), columns, rows },
	]);
}

/** Delivers several encoded records through one carrier inside one act(). */
export async function deliverRecords(
	onRecord: ((record: ArrayBuffer) => void) | undefined,
	...records: Uint8Array[]
): Promise<void> {
	await act(async () => {
		for (const record of records) onRecord?.(record.buffer as ArrayBuffer);
	});
}

/**
 * Waits for the single pending semantic resize, acknowledges it as applied
 * with the given grid, then delivers a settled frame built from `frame`.
 */
export async function settleInitialResize(
	onRecord: ((record: ArrayBuffer) => void) | undefined,
	columns: number,
	rows: number,
	frame: ViewportFrameRecordOptions,
): Promise<void> {
	await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
	const [resize] = sentRecords("inputIntent");
	await deliverRecords(
		onRecord,
		resizeAppliedReceiptRecord(resize?.metadata.recordId ?? 0n, columns, rows),
		viewportFrameRecord(frame),
	);
	await flushFrames();
}

/** UTF-8 payloads of every outbound text input intent, in send order. */
export function sentTextPayloads(): string[] {
	return sentInputIntents("text").map(({ record }) => {
		if (
			record.body.case !== "inputIntent" ||
			record.body.value.intent.case !== "text"
		) {
			throw new Error("expected a structured text input intent");
		}
		return new TextDecoder().decode(record.body.value.intent.value.utf8);
	});
}

/** Builds a window focus probe whose QA surface is captured on connect. */
export function createWindowFocusProbe(disconnect: () => void = () => {}) {
	let surface: TerminalWindowFocusProbeSurface | undefined;
	const probe: TerminalWindowFocusProbe = {
		connect: vi.fn((connected) => {
			surface = connected;
			return disconnect;
		}),
		onHydrationChange: vi.fn(),
		onSynchronized: vi.fn(),
		onPresented: vi.fn(),
		onError: vi.fn(),
	};
	const qaSurface = () => {
		if (!surface) throw new Error("window focus probe is not connected");
		return surface;
	};
	return { probe, qaSurface };
}

/** Renders the terminal beside an outside button that starts focused. */
export function renderTerminalBesideOutsideButton() {
	const view = render(
		<div>
			<button type="button">outside input</button>
			{terminalElement("session-a")}
		</div>,
	);
	const outside = view.getByRole("button", { name: "outside input" });
	outside.focus();
	return { view, outside };
}

/**
 * Runs the standard boot prologue shared by most suites: install the
 * standard attach mock, render the view, and wait for exactly one attach.
 */
export async function bootTerminal(): Promise<{
	readonly onRecords: Array<(record: ArrayBuffer) => void>;
	readonly view: ReturnType<typeof renderTerminalView>;
}> {
	const onRecords = installAttachMock();
	const view = renderTerminalView();
	await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
	return { onRecords, view };
}

/** bootTerminal plus one initial complete viewport frame built from options. */
export async function bootTerminalWithFrame(
	options: ViewportFrameRecordOptions = {},
): Promise<{
	readonly onRecords: Array<(record: ArrayBuffer) => void>;
	readonly view: ReturnType<typeof renderTerminalView>;
}> {
	const boot = await bootTerminal();
	await deliverViewportFrame(boot.onRecords[0], options);
	return boot;
}

/** The shared beforeEach body: resets every mock and controlled global. */
export function resetStructuredTerminalHarness(): void {
	terminalInputLatency.resetMeasurements();
	protocolMocks.decodeCalls = 0;
	resizeObservers.length = 0;
	frames.clear();
	nextFrame = 1;
	nextUuid = 1;
	window.getSelection()?.removeAllRanges();
	mocks.attach.mockReset();
	mocks.pullRecords.clear();
	mocks.pullWaiters.clear();
	mocks.remoteKnownHostTrust.mockReset().mockResolvedValue({
		schemaVersion: 1,
		hostId: "host-rts",
		hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
	});
	mocks.remoteCatalog.mockReset().mockResolvedValue({
		schemaVersion: 1,
		hostId: "host-rts",
		sessions: [
			{
				sessionId: "standalone_source",
				workspaceId: "workspace_source",
				sessionClass: "standalone",
				lifecycle: "ready",
				providerId: "shell",
				runnerPrincipal: "rts",
				runnerInstance: "runner-source",
				channelEpoch: "1",
				hostInstanceId: "host-source",
				terminalEpoch: "terminal-a",
				supportedProtocol: {
					minimum: { major: 1, minor: 0 },
					maximum: { major: 1, minor: 0 },
				},
				capabilities: ["terminal_state_binary_v1"],
			},
		],
	});
	mocks.workspaceActive = true;
	mocks.detach.mockClear();
	mocks.send.mockReset();
	mocks.send.mockResolvedValue("record-1");
	mocks.measure.mockReset();
	mocks.measure.mockImplementation((width: number, height: number) => ({
		cellWidth: 10,
		rowHeight: 20,
		columns: Math.max(1, Math.floor(width / 10)),
		rows: Math.max(1, Math.floor(height / 20)),
		asciiRunCapability: "fixed_cell_advance" as const,
	}));
	mocks.invalidateMetrics.mockClear();
	mocks.readClipboardImage.mockReset();
	mocks.readClipboardText.mockReset();
	mocks.saveTempImage.mockReset();
	mocks.saveTempFiles.mockReset();
	mocks.uploadSshFilesToTemp.mockReset();
	mocks.routeSessionFiles
		.mockReset()
		.mockImplementation(async ({ paths }: { paths: string[] }) => paths);
	mocks.writeClipboard.mockClear();
	mocks.showToast.mockClear();
	mocks.setHmuxSessionMetadata.mockClear();
	mocks.setSessionAgent.mockClear();
	mocks.setSessionAgentPin.mockClear();
	mocks.setSessionAgentRuntimeState.mockClear();
	mocks.setSessionCwd.mockClear();
	mocks.setSessionTitle.mockClear();
	mocks.recoveryAdmission = new StructuredTerminalRecoveryAdmission();
	mocks.desktopId = undefined;
	mocks.largeViewReturnComplete.mockClear();
	mocks.largeViewReturnDispose.mockClear();
	mocks.largeViewReturnConceal.mockClear();
	mocks.largeViewReturnPrepare = undefined;
	mocks.largeViewReturnRetired = undefined;
	mocks.windowFocused = true;
	Object.assign(mocks, { terminalFontSize: 14, terminalLineHeight: 1.25 });
	mocks.windowFocusListeners.clear();
	mocks.largeViewReturnOptions = undefined;
	mocks.bindLargeViewReturnSource.mockReset().mockImplementation((options) => {
		mocks.largeViewReturnOptions = options;
		mocks.largeViewReturnRetired = options.retired;
		let activeGeneration: string | undefined;
		mocks.largeViewReturnPrepare = (nextGeneration) => {
			if (options.prepare?.(nextGeneration) === false) return false;
			const alreadyConcealed = activeGeneration !== undefined;
			activeGeneration = nextGeneration;
			if (!alreadyConcealed) {
				mocks.largeViewReturnConceal();
				options.conceal();
			}
			return true;
		};
		return {
			currentGeneration: () => activeGeneration,
			complete: (candidate: string | undefined) => {
				mocks.largeViewReturnComplete(candidate);
				if (candidate === undefined || candidate !== activeGeneration)
					return false;
				activeGeneration = undefined;
				options.reveal();
				return true;
			},
			dispose: () => {
				mocks.largeViewReturnDispose();
				if (activeGeneration !== undefined) {
					activeGeneration = undefined;
					options.reveal();
				}
			},
		};
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			readonly controlled: ControlledResizeObserver;
			constructor(callback: ResizeObserverCallback) {
				this.controlled = { callback, targets: [] };
				resizeObservers.push(this.controlled);
			}
			observe = (target: Element) => this.controlled.targets.push(target);
			disconnect = vi.fn();
			unobserve = vi.fn();
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const frame = nextFrame++;
		frames.set(frame, callback);
		return frame;
	});
	vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
		frames.delete(frame),
	);
	Object.defineProperty(globalThis.crypto, "randomUUID", {
		configurable: true,
		value: () =>
			`00000000-0000-4000-8000-${String(nextUuid++).padStart(12, "0")}`,
	});
	installSashDragHighlight(document);
}

/** The shared afterEach body: unmounts and restores every stubbed global. */
export function restoreStructuredTerminalHarness(): void {
	cleanup();
	terminalInputLatency.resetMeasurements();
	restoreDocumentFonts();
	restoreDocumentFonts = () => {};
	vi.unstubAllGlobals();
}
