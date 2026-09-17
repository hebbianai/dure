// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	registerTerminalDocumentResizeSurface,
	terminalDocumentResizePhase,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type {
	LargeViewReturnIdentity,
	LargeViewReturnLifecycleRequestBackend,
	LargeViewReturnSourceBackend,
	PreparedLargeViewReturn,
} from "@/lib/workspace/window/largeViewReturnHandoff";
import { LargeViewReturnSourceTransaction } from "@/lib/workspace/window/largeViewReturnTransaction";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	setTitle: vi.fn(async () => {}),
	startDragging: vi.fn(async () => {}),
	toggleMaximize: vi.fn(async () => {}),
	toggleWindowMaximizeAtomic: vi.fn(async () => {}),
	hide: vi.fn(async () => {}),
	show: vi.fn(async () => {}),
	unminimize: vi.fn(async () => {}),
	setFocus: vi.fn(async () => {}),
	close: vi.fn(async () => {}),
	windowLabel: "win-session-agent-1",
	onCloseRequested: vi.fn(),
	closeRequested: undefined as
		| undefined
		| ((event: { preventDefault: () => void }) => Promise<void>),
	restoreWindowAfterSecondaryClose: vi.fn(async () => {}),
	markLargeSurfaceRetired: vi.fn(async () => {}),
	beginLargeViewReturnToWindow: vi.fn(
		async (
			_identity: LargeViewReturnIdentity,
			_replyWindowLabel: string,
			_targetWindowLabel: string,
		): Promise<PreparedLargeViewReturn | undefined> => ({
			generation: "return-1",
			markLargeSurfaceRetired: mocks.markLargeSurfaceRetired,
		}),
	),
	currentAgentSessionSource: vi.fn(
		(
			_agentId: string,
			fallback: { windowLabel: string; paneOwnerId?: string },
		) => fallback,
	),
	subscribeAgentSessionSource: vi.fn(() => vi.fn()),
	startWebviewKeyboardFocus: vi.fn(() => vi.fn()),
	startWindowSync: vi.fn(() => vi.fn()),
	setAgentSessionSourceOpen: vi.fn(),
	publishAgentSessionRuntimeState: vi.fn(async () => {}),
	settleDurableAppState: vi.fn(async () => {}),
	rehydrateDurableStore: vi.fn(async () => {}),
	requestAgentSessionCredentialCommand: vi.fn(async () => ({
		kind: "completed" as const,
		conversationId: "conversation-1",
	})),
	requestAgentSessionForkPresentation: vi.fn(async () => ({
		kind: "presented" as const,
	})),
	forkAgent: vi.fn(),
	messageDialog: vi.fn(async () => {}),
	requestManagedCredentialSwitch: vi.fn(async () => ({
		kind: "completed" as const,
		conversationId: "conversation-1",
	})),
	preloadTerminalFont: vi.fn(),
	terminalUnmounted: vi.fn(),
	structuredSurfaceRetirement: Promise.resolve() as Promise<void>,
	structuredSurfaceRetirementReporter: undefined as
		| undefined
		| ((retirement: Promise<void>) => void),
	autoObserveGeometry: true,
	geometryObserved: undefined as undefined | (() => void),
	liveResizeListener: undefined as
		| undefined
		| ((phase: "begin" | "end") => void),
	liveResizeUnsubscribe: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		label: mocks.windowLabel,
		setTitle: mocks.setTitle,
		startDragging: mocks.startDragging,
		toggleMaximize: mocks.toggleMaximize,
		hide: mocks.hide,
		show: mocks.show,
		unminimize: mocks.unminimize,
		setFocus: mocks.setFocus,
		close: mocks.close,
		onCloseRequested: mocks.onCloseRequested,
	}),
}));
vi.mock("@/lib/workspace/window/agentSessionWindowCommand", () => ({
	requestAgentSessionCredentialCommand:
		mocks.requestAgentSessionCredentialCommand,
	requestAgentSessionForkPresentation:
		mocks.requestAgentSessionForkPresentation,
}));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["codex"],
}));
vi.mock("@/lib/agents/fork", () => ({
	forkAgent: mocks.forkAgent,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	message: mocks.messageDialog,
}));
vi.mock("@/lib/sessions/credentials/deferredCredentialSwitchRuntime", () => ({
	applyDeferredCredentialSwitchNow: vi.fn(async () => {}),
	cancelDeferredCredentialSwitch: vi.fn(() => true),
	requestManagedCredentialSwitch: mocks.requestManagedCredentialSwitch,
}));
vi.mock("@/lib/workspace/window/windows", () => ({
	restoreWindowAfterSecondaryClose: mocks.restoreWindowAfterSecondaryClose,
	startWebviewKeyboardFocus: mocks.startWebviewKeyboardFocus,
	startWindowSync: mocks.startWindowSync,
	useNativeShellGlass: vi.fn(),
	useNativeTrafficLightDrop: vi.fn(),
}));
vi.mock("@/lib/ipc/system", async (original) => ({
	...(await original<typeof import("@/lib/ipc/system")>()),
	usageRecent: vi.fn(async () => { throw new Error("Fixture usage snapshot unavailable"); }),
	toggleWindowMaximizeAtomic: mocks.toggleWindowMaximizeAtomic,
}));
vi.mock("@/lib/workspace/window/agentSessionWindowSource", () => ({
	currentAgentSessionSource: mocks.currentAgentSessionSource,
	normalizeAgentSessionSourcePaneOwnerId: (value: unknown) =>
		typeof value === "string" && value.length > 0 ? value : undefined,
	normalizeAgentSessionSourceWindowLabel: (value: unknown) =>
		typeof value === "string" && value.length > 0 ? value : "main",
	setAgentSessionSourceOpen: mocks.setAgentSessionSourceOpen,
	publishAgentSessionRuntimeState: mocks.publishAgentSessionRuntimeState,
	subscribeAgentSessionSource: mocks.subscribeAgentSessionSource,
}));
vi.mock("@/lib/terminal/renderer/terminalFontPreload", () => ({
	preloadTerminalFont: mocks.preloadTerminalFont,
}));
vi.mock("@/lib/workspace/window/largeViewReturnHandoff", () => ({
	beginLargeViewReturnToWindow: mocks.beginLargeViewReturnToWindow,
}));
vi.mock("@/lib/persistence/durableAppStateSettlement", () => ({
	settleDurableAppState: mocks.settleDurableAppState,
}));
vi.mock("@/lib/persistence/durableStoreRehydration", () => ({
	rehydrateDurableStore: mocks.rehydrateDurableStore,
}));
vi.mock("@/lib/workspace/window/currentWindowResize", () => ({
	subscribeCurrentWindowLiveResize: vi.fn(
		async (listener: (phase: "begin" | "end") => void) => {
			mocks.liveResizeListener = listener;
			return mocks.liveResizeUnsubscribe;
		},
	),
}));
vi.mock("@/lib/theme/themePreference", () => ({
	useResolvedDark: () => true,
	useRootDarkClass: vi.fn(),
}));
vi.mock("@/lib/platform/windowAppearance", () => ({
	nativeWindowTitle: (title: string) => title,
	useNativeWindowTheme: vi.fn(),
}));
vi.mock("@/lib/workspace/window/windowShellShape", () => ({
	shellChromeClass: () => "rounded-[12px] shadow-shell",
	shellEdgeOverlayClass: () =>
		"pointer-events-none absolute inset-0 z-50 rounded-[12px] inset-ring-1 inset-ring-foreground/15",
	useWindowShellShape: () => false,
}));
vi.mock("@/components/settings/useAppLanguage", () => ({
	useAppLanguage: () => "ko",
}));
vi.mock("@/lib/workspace/window/windowShortcutHooks", () => ({
	useTerminalFontShortcut: vi.fn(),
}));
vi.mock("@/components/Toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/terminal/TerminalView", () => ({
	TerminalView: ({
		sessionId,
		providerHint,
		onGeometryObserved,
		onStructuredSurfaceRetirement,
	}: {
		sessionId: string;
		providerHint?: "codex" | "claude";
		onGeometryObserved?: () => void;
		onStructuredSurfaceRetirement?: (retirement: Promise<void>) => void;
	}) => {
		useEffect(() => {
			mocks.geometryObserved = onGeometryObserved;
			mocks.structuredSurfaceRetirementReporter =
				onStructuredSurfaceRetirement;
			if (mocks.autoObserveGeometry) onGeometryObserved?.();
		}, [onGeometryObserved, onStructuredSurfaceRetirement]);
		useEffect(
			() => () => {
				onStructuredSurfaceRetirement?.(mocks.structuredSurfaceRetirement);
				mocks.terminalUnmounted();
			},
			[onStructuredSurfaceRetirement],
		);
		return (
			<div
				data-testid="terminal-view"
				data-session-id={sessionId}
				data-provider-hint={providerHint}
			/>
		);
	},
}));

import { AgentSessionWindowRoot } from "@/components/workspace/AgentSessionWindow";

const target: Agent = agentFixture({
	displayName: "UI polish",
	runtimeBinding: hmuxManagedBinding("session-1", "workspace-1"),
});

beforeEach(() => {
	// The large-view fork flows are pro surfaces; basic folds the fork menu.
	useStore.setState((state) => ({
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
	}));
	mocks.autoObserveGeometry = true;
	mocks.geometryObserved = undefined;
	mocks.liveResizeListener = undefined;
	mocks.liveResizeUnsubscribe.mockReset();
	mocks.closeRequested = undefined;
	mocks.structuredSurfaceRetirement = Promise.resolve();
	mocks.structuredSurfaceRetirementReporter = undefined;
	mocks.markLargeSurfaceRetired.mockReset().mockResolvedValue(undefined);
	mocks.beginLargeViewReturnToWindow.mockReset().mockResolvedValue({
		generation: "return-1",
		markLargeSurfaceRetired: mocks.markLargeSurfaceRetired,
	});
	mocks.restoreWindowAfterSecondaryClose
		.mockReset()
		.mockResolvedValue(undefined);
	mocks.hide.mockReset().mockResolvedValue(undefined);
	mocks.show.mockReset().mockResolvedValue(undefined);
	mocks.unminimize.mockReset().mockResolvedValue(undefined);
	mocks.setFocus.mockReset().mockResolvedValue(undefined);
	mocks.close.mockReset().mockResolvedValue(undefined);
	mocks.setAgentSessionSourceOpen.mockReset();
	mocks.publishAgentSessionRuntimeState
		.mockReset()
		.mockResolvedValue(undefined);
	mocks.settleDurableAppState.mockReset().mockResolvedValue(undefined);
	mocks.rehydrateDurableStore.mockReset().mockResolvedValue(undefined);
	mocks.requestAgentSessionCredentialCommand.mockReset().mockResolvedValue({
		kind: "completed",
		conversationId: "conversation-1",
	});
	mocks.requestAgentSessionForkPresentation.mockReset().mockResolvedValue({
		kind: "presented",
	});
	mocks.forkAgent.mockReset().mockResolvedValue({
		...target,
		id: "agent-fork",
		sessionId: "agent-fork",
		name: "UI polish-fork",
	});
	mocks.messageDialog.mockReset().mockResolvedValue(undefined);
	mocks.requestManagedCredentialSwitch.mockReset().mockResolvedValue({
		kind: "completed",
		conversationId: "conversation-1",
	});
	mocks.toggleWindowMaximizeAtomic.mockReset().mockResolvedValue(undefined);
	mocks.onCloseRequested.mockImplementation(async (handler) => {
		mocks.closeRequested = handler;
		return vi.fn();
	});
	useStore.setState({
		agents: [target],
		sessionCwd: { "session-1": "/repo/.worktrees/agent-1/src" },
		sessionAgentRuntimeState: {},
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AgentSessionWindowRoot", () => {
	it("commits one final geometry after an ordinary native border drag", async () => {
		const commit = vi.fn();
		render(<AgentSessionWindowRoot agentId="agent-1" />);
		await waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		const registration = registerTerminalDocumentResizeSurface(document, {
			surfaceKey: "session-1",
			sessionKey: "session-1",
			canCommit: () => true,
			commit,
		});

		mocks.liveResizeListener?.("begin");
		for (let index = 0; index < 3; index += 1) {
			const observation = registration.noteGeometryChanged();
			if (observation) await registration.commitOrdinary(observation);
		}

		expect(commit).not.toHaveBeenCalled();
		mocks.liveResizeListener?.("end");
		await waitFor(() => expect(commit).toHaveBeenCalledOnce());
		expect(terminalDocumentResizePhase(document)).toBe("idle");
		registration.dispose();
	});

	it("commits the first attached large-view geometry once", async () => {
		mocks.autoObserveGeometry = false;
		const commit = vi.fn();
		const registration = registerTerminalDocumentResizeSurface(document, {
			surfaceKey: "session-1",
			sessionKey: "session-1",
			canCommit: () => true,
			commit,
		});

		render(<AgentSessionWindowRoot agentId="agent-1" />);
		await waitFor(() => expect(mocks.geometryObserved).toBeTypeOf("function"));
		expect(terminalDocumentResizePhase(document)).toBe("dragging");
		expect(registration.noteGeometryChanged()).toBeUndefined();
		expect(commit).not.toHaveBeenCalled();

		mocks.geometryObserved?.();
		await waitFor(() => expect(commit).toHaveBeenCalledOnce());
		expect(terminalDocumentResizePhase(document)).toBe("idle");
		registration.dispose();
	});

	it("keeps the source renderer until the large view installs its first frame", async () => {
		mocks.autoObserveGeometry = false;

		render(<AgentSessionWindowRoot agentId="agent-1" />);

		await waitFor(() => expect(mocks.geometryObserved).toBeTypeOf("function"));
		expect(mocks.setAgentSessionSourceOpen).not.toHaveBeenCalledWith(
			"agent-1",
			{ windowLabel: "main", paneOwnerId: undefined },
			true,
		);

		act(() => mocks.geometryObserved?.());

		await waitFor(() =>
			expect(mocks.setAgentSessionSourceOpen).toHaveBeenCalledWith(
				"agent-1",
				{ windowLabel: "main", paneOwnerId: undefined },
				true,
			),
		);
	});

	it("does not open a structured geometry transaction for a remote runtime", () => {
		mocks.autoObserveGeometry = false;
		const remoteAgent: Agent = {
			...target,
			sessionId: "remote-session-1",
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "remote-host-1",
				sessionId: "remote-session-1",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-1",
				commandBridgeNonce: "bridge-1",
			},
		};

		render(
			<AgentSessionWindowRoot
				agentId={remoteAgent.id}
				agentOverride={remoteAgent}
			/>,
		);

		expect(terminalDocumentResizePhase(document)).toBe("idle");
	});

	it("holds native maximize geometry until the exact action completes", async () => {
		let completeMaximize!: () => void;
		mocks.toggleWindowMaximizeAtomic.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					completeMaximize = resolve;
				}),
		);
		const commit = vi.fn();
		const registration = registerTerminalDocumentResizeSurface(document, {
			surfaceKey: "session-1",
			sessionKey: "session-1",
			canCommit: () => true,
			commit,
		});
		render(<AgentSessionWindowRoot agentId="agent-1" />);
		await waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		commit.mockClear();

		fireEvent.mouseDown(screen.getByRole("banner"), {
			button: 0,
			detail: 2,
		});
		expect(terminalDocumentResizePhase(document)).toBe("dragging");
		const observation = registration.noteGeometryChanged();
		if (observation) await registration.commitOrdinary(observation);
		expect(commit).not.toHaveBeenCalled();

		completeMaximize();
		await waitFor(() => expect(commit).toHaveBeenCalledOnce());
		expect(terminalDocumentResizePhase(document)).toBe("idle");
		registration.dispose();
	});

	it("renders the persisted Hmux session without creating a pane", () => {
		const rendered = render(<AgentSessionWindowRoot agentId="agent-1" />);

		expect(screen.getByTestId("terminal-view").dataset.sessionId).toBe(
			"session-1",
		);
		expect(screen.getByTestId("terminal-view").dataset.providerHint).toBe(
			target.provider,
		);
		expect(rendered.container.firstElementChild?.className).toContain(
			"shadow-shell",
		);
		expect(mocks.setAgentSessionSourceOpen).toHaveBeenCalledWith(
			"agent-1",
			{ windowLabel: "main", paneOwnerId: undefined },
			true,
		);
		expect(screen.getByText("src")).toBeTruthy();
		expect(mocks.startWebviewKeyboardFocus).toHaveBeenCalledOnce();
		expect(mocks.startWindowSync).toHaveBeenCalledOnce();
		expect(mocks.setTitle).toHaveBeenCalledWith("Dure — UI polish");
	});

	it("projects large-view Agent activity back to its source window", async () => {
		render(<AgentSessionWindowRoot agentId="agent-1" />);
		const runtimeState = {
			terminalEpoch: "terminal-1",
			revision: "1",
			observedThroughOutputSeq: "9",
			lifecycle: "running" as const,
			activity: "working" as const,
			attention: "none" as const,
			source: "controller_input" as const,
		};

		act(() =>
			useStore
				.getState()
				.setSessionAgentRuntimeState("session-1", runtimeState),
		);

		await waitFor(() =>
			expect(mocks.publishAgentSessionRuntimeState).toHaveBeenCalledWith(
				"main",
				"session-1",
				runtimeState,
			),
		);
	});

	it("does not require legacy conversation identity for a structured large-view credential action", () => {
		useStore.setState({
			accounts: [
				{
					id: "account-1",
					provider: "codex",
					name: "Work",
					dir: "/credentials/work",
				},
			],
		});

		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:agent-1"
			/>,
		);

		expect(
			(
				screen.getByRole("button", { name: "이 pane에서 쓸 계정" }) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("shows the credential committed to the large-view runtime instead of the global account", () => {
		useStore.setState({
			agents: [
				{
					...target,
					accountId: undefined,
					credentialId: "account-stale",
					executionProfile: {
						kind: "credential_reference",
						reference_id: "account-runtime",
						credential_generation: "generation-runtime",
					},
				},
			],
			accounts: [
				{
					id: "account-runtime",
					provider: "codex",
					name: "Runtime",
					dir: "/credentials/runtime",
				},
				{
					id: "account-global",
					provider: "codex",
					name: "Global",
					dir: "/credentials/global",
				},
			],
			activeAccounts: { codex: "account-global" },
		});

		render(<AgentSessionWindowRoot agentId="agent-1" />);

		expect(screen.getByText("Runtime")).toBeTruthy();
		expect(screen.queryByText("Global")).toBeNull();
	});

	it("keeps a committed provider default visible over stale credential projections", () => {
		useStore.setState({
			agents: [
				{
					...target,
					accountId: "account-stale",
					credentialId: "account-stale",
					executionProfile: { kind: "provider_default" },
				},
			],
			accounts: [
				{
					id: "account-stale",
					provider: "codex",
					name: "Stale",
					dir: "/credentials/stale",
				},
			],
			activeAccounts: { codex: "account-stale" },
		});

		render(<AgentSessionWindowRoot agentId="agent-1" />);

		expect(screen.getByText(t("common.default"))).toBeTruthy();
		expect(screen.queryByText("Stale")).toBeNull();
	});

	it("routes an account switch to the exact source window instead of resolving a local pane", async () => {
		useStore.setState({
			agents: [
				{
					...target,
					credentialId: "account-1",
					conversationId: "conversation-1",
					conversationIdentity: {
						state: "ready",
						conversationId: "conversation-1",
					},
				},
			],
			accounts: [
				{
					id: "account-1",
					provider: "codex",
					name: "Current",
					dir: "/credentials/current",
				},
				{
					id: "account-2",
					provider: "codex",
					name: "Next",
					dir: "/credentials/next",
				},
			],
		});
		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:agent-1"
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: "이 pane에서 쓸 계정" }),
			{
				button: 0,
			},
		);
		fireEvent.click(await screen.findByText("Next"));

		await waitFor(() =>
			expect(mocks.requestAgentSessionCredentialCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "switch",
					agentId: "agent-1",
					sourceWindowLabel: "win-workspace-2",
					sourcePaneOwnerId: "desktop-2:agent:agent-1",
					targetCredentialId: "account-2",
				}),
			),
		);
		expect(mocks.requestManagedCredentialSwitch).not.toHaveBeenCalled();
	});

	it("asks the source window to present a fork created from the large view", async () => {
		const rendered = render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:agent-1"
			/>,
		);

		fireEvent.contextMenu(
			rendered.container.querySelector("[data-agent-panel-toolbar]")!,
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: /Codex/ }));

		await waitFor(() =>
			expect(mocks.forkAgent).toHaveBeenCalledWith("agent-1", "codex"),
		);
		expect(mocks.requestAgentSessionForkPresentation).toHaveBeenCalledWith({
			agentId: "agent-1",
			forkedAgentId: "agent-fork",
			sourceWindowLabel: "win-workspace-2",
			sourcePaneOwnerId: "desktop-2:agent:agent-1",
		});
		expect(mocks.rehydrateDurableStore).toHaveBeenCalledOnce();
		expect(mocks.rehydrateDurableStore.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.requestAgentSessionForkPresentation.mock.invocationCallOrder[0],
		);
	});

	it("shows a large-view fork presentation failure in the window where it was requested", async () => {
		mocks.requestAgentSessionForkPresentation.mockRejectedValueOnce(
			new Error("source pane is unavailable"),
		);
		const rendered = render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:agent-1"
			/>,
		);

		fireEvent.contextMenu(
			rendered.container.querySelector("[data-agent-panel-toolbar]")!,
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: /Codex/ }));

		await waitFor(() =>
			expect(mocks.messageDialog).toHaveBeenCalledWith(
				t("workspace.agentWindow.forkPresentationFailed"),
				{ kind: "error" },
			),
		);
	});

	it("detaches the presentation safely when the Agent is deleted", () => {
		render(<AgentSessionWindowRoot agentId="agent-1" />);
		expect(screen.getByTestId("terminal-view")).toBeTruthy();

		act(() => {
			useStore.setState({ agents: [] });
		});

		expect(screen.queryByTestId("terminal-view")).toBeNull();
		expect(screen.getAllByText("삭제된 에이전트입니다")).toHaveLength(2);
	});

	it("retires the structured surface before returning focus and closing", async () => {
		mocks.markLargeSurfaceRetired.mockImplementation(async () => {
			expect(mocks.terminalUnmounted).toHaveBeenCalledOnce();
		});
		mocks.restoreWindowAfterSecondaryClose.mockImplementation(async () => {
			expect(mocks.markLargeSurfaceRetired).toHaveBeenCalledOnce();
		});
		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:1"
			/>,
		);
		await vi.waitFor(() => expect(mocks.closeRequested).toBeTypeOf("function"));
		const preventDefault = vi.fn();

		await act(async () => {
			await mocks.closeRequested?.({ preventDefault });
		});

		expect(preventDefault).toHaveBeenCalledOnce();
		expect(mocks.beginLargeViewReturnToWindow).toHaveBeenCalledWith(
			{
				workspaceId: "workspace-1",
				sessionId: "session-1",
				sourcePaneOwnerId: "desktop-2:agent:1",
			},
			"win-session-agent-1",
			"win-workspace-2",
		);
		expect(mocks.setAgentSessionSourceOpen).toHaveBeenCalledWith(
			"agent-1",
			{
				windowLabel: "win-workspace-2",
				paneOwnerId: "desktop-2:agent:1",
			},
			false,
		);
		expect(
			mocks.setAgentSessionSourceOpen.mock.invocationCallOrder[
				mocks.setAgentSessionSourceOpen.mock.invocationCallOrder.length - 1
			],
		).toBeLessThan(
			mocks.beginLargeViewReturnToWindow.mock.invocationCallOrder[0],
		);
		expect(mocks.restoreWindowAfterSecondaryClose).toHaveBeenCalledWith(
			"win-workspace-2",
		);
		expect(mocks.settleDurableAppState).toHaveBeenCalledOnce();
		expect(
			mocks.beginLargeViewReturnToWindow.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.terminalUnmounted.mock.invocationCallOrder[0]);
		expect(
			mocks.markLargeSurfaceRetired.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.restoreWindowAfterSecondaryClose.mock.invocationCallOrder[0],
		);
		expect(
			mocks.restoreWindowAfterSecondaryClose.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.settleDurableAppState.mock.invocationCallOrder[0]);
		expect(
			mocks.settleDurableAppState.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
		expect(mocks.close).toHaveBeenCalledOnce();
		expect(screen.queryByTestId("terminal-view")).toBeNull();
	});

	it("keeps the native window open until durable app state settles", async () => {
		let releaseDurable!: () => void;
		mocks.settleDurableAppState.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseDurable = resolve;
				}),
		);
		render(<AgentSessionWindowRoot agentId="agent-1" />);
		await vi.waitFor(() => expect(mocks.closeRequested).toBeTypeOf("function"));

		let closing: Promise<void> | undefined;
		act(() => {
			closing = mocks.closeRequested?.({ preventDefault: vi.fn() });
		});
		await waitFor(() =>
			expect(mocks.restoreWindowAfterSecondaryClose).toHaveBeenCalledOnce(),
		);

		expect(mocks.close).not.toHaveBeenCalled();
		releaseDurable();
		await act(async () => {
			await closing;
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("conceals the native window before the source renderer remounts", async () => {
		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:1"
			/>,
		);
		await vi.waitFor(() => expect(mocks.closeRequested).toBeTypeOf("function"));

		await act(async () => {
			await mocks.closeRequested?.({ preventDefault: vi.fn() });
		});

		expect(mocks.hide).toHaveBeenCalledOnce();
		const hideOrder = mocks.hide.mock.invocationCallOrder[0];
		const sourceRemountCall =
			mocks.setAgentSessionSourceOpen.mock.calls.findIndex(
				([, , open], index) =>
					open === false &&
					mocks.setAgentSessionSourceOpen.mock.invocationCallOrder[index] >
						hideOrder,
			);
		expect(sourceRemountCall).toBeGreaterThanOrEqual(0);
		expect(hideOrder).toBeLessThan(
			mocks.setAgentSessionSourceOpen.mock.invocationCallOrder[
				sourceRemountCall
			],
		);
		expect(hideOrder).toBeLessThan(
			mocks.beginLargeViewReturnToWindow.mock.invocationCallOrder[0],
		);
	});

	it("remounts before revealing the large window when native close fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.close.mockRejectedValueOnce(new Error("close failed"));
		mocks.show.mockImplementation(async () => {
			expect(screen.getByTestId("terminal-view")).toBeTruthy();
		});
		try {
			render(
				<AgentSessionWindowRoot
					agentId="agent-1"
					sourceWindowLabel="win-workspace-2"
					sourcePaneOwnerId="desktop-2:agent:1"
				/>,
			);
			await vi.waitFor(() =>
				expect(mocks.closeRequested).toBeTypeOf("function"),
			);

			await act(async () => {
				await mocks.closeRequested?.({ preventDefault: vi.fn() });
			});

			expect(mocks.hide).toHaveBeenCalledOnce();
			expect(mocks.show).toHaveBeenCalledOnce();
			expect(mocks.unminimize).toHaveBeenCalledOnce();
			expect(mocks.setFocus).toHaveBeenCalledOnce();
			expect(mocks.show.mock.invocationCallOrder[0]).toBeLessThan(
				mocks.setFocus.mock.invocationCallOrder[0],
			);
			expect(mocks.setAgentSessionSourceOpen).toHaveBeenLastCalledWith(
				"agent-1",
				{
					windowLabel: "win-workspace-2",
					paneOwnerId: "desktop-2:agent:1",
				},
				true,
			);
		} finally {
			error.mockRestore();
		}
	});

	it("reprepares the large-view return before closing after a durability failure", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.settleDurableAppState.mockRejectedValue(
			new Error("durable write failed"),
		);
		try {
			render(
				<AgentSessionWindowRoot
					agentId="agent-1"
					sourceWindowLabel="win-workspace-2"
					sourcePaneOwnerId="desktop-2:agent:1"
				/>,
			);
			await vi.waitFor(() =>
				expect(mocks.closeRequested).toBeTypeOf("function"),
			);

			await act(async () => {
				await mocks.closeRequested?.({ preventDefault: vi.fn() });
			});
			expect(mocks.close).not.toHaveBeenCalled();
			expect(screen.getByTestId("terminal-view")).toBeTruthy();

			await act(async () => {
				await mocks.closeRequested?.({ preventDefault: vi.fn() });
			});

			expect(mocks.hide).toHaveBeenCalledTimes(2);
			expect(mocks.beginLargeViewReturnToWindow).toHaveBeenCalledTimes(2);
			expect(mocks.settleDurableAppState).toHaveBeenCalledTimes(2);
			expect(mocks.close).toHaveBeenCalledOnce();
			expect(mocks.setAgentSessionSourceOpen).toHaveBeenLastCalledWith(
				"agent-1",
				{
					windowLabel: "win-workspace-2",
					paneOwnerId: "desktop-2:agent:1",
				},
				false,
			);
			expect(screen.queryByTestId("terminal-view")).toBeNull();
		} finally {
			error.mockRestore();
		}
	});

	it("does not signal or focus the source before structured detach completes", async () => {
		let finishRetirement!: () => void;
		mocks.structuredSurfaceRetirement = new Promise<void>((resolve) => {
			finishRetirement = resolve;
		});
		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:1"
			/>,
		);
		await vi.waitFor(() => expect(mocks.closeRequested).toBeTypeOf("function"));
		let closing: Promise<void> | undefined;
		act(() => {
			closing = mocks.closeRequested?.({ preventDefault: vi.fn() });
		});
		await waitFor(() => expect(mocks.terminalUnmounted).toHaveBeenCalledOnce());

		expect(mocks.markLargeSurfaceRetired).not.toHaveBeenCalled();
		expect(mocks.restoreWindowAfterSecondaryClose).not.toHaveBeenCalled();

		finishRetirement();
		await act(async () => {
			await closing;
		});

		expect(mocks.markLargeSurfaceRetired).toHaveBeenCalledOnce();
		expect(
			mocks.markLargeSurfaceRetired.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.restoreWindowAfterSecondaryClose.mock.invocationCallOrder[0],
		);
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("does not claim retirement when structured detach fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let failRetirement!: (error: Error) => void;
		mocks.structuredSurfaceRetirement = new Promise<void>(
			(_resolve, reject) => {
				failRetirement = reject;
			},
		);
		try {
			render(
				<AgentSessionWindowRoot
					agentId="agent-1"
					sourceWindowLabel="win-workspace-2"
					sourcePaneOwnerId="desktop-2:agent:1"
				/>,
			);
			await vi.waitFor(() =>
				expect(mocks.closeRequested).toBeTypeOf("function"),
			);

			let closing: Promise<void> | undefined;
			act(() => {
				closing = mocks.closeRequested?.({ preventDefault: vi.fn() });
			});
			await waitFor(() =>
				expect(mocks.terminalUnmounted).toHaveBeenCalledOnce(),
			);
			failRetirement(new Error("detach failed"));
			await act(async () => {
				await closing;
			});

			expect(mocks.markLargeSurfaceRetired).not.toHaveBeenCalled();
			expect(mocks.restoreWindowAfterSecondaryClose).toHaveBeenCalledOnce();
			expect(mocks.close).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(
				"[hmux] failed to retire the large structured surface",
				expect.any(Error),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not forget a failed predecessor retirement after reattach", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			render(
				<AgentSessionWindowRoot
					agentId="agent-1"
					sourceWindowLabel="win-workspace-2"
					sourcePaneOwnerId="desktop-2:agent:1"
				/>,
			);
			await vi.waitFor(() =>
				expect(mocks.structuredSurfaceRetirementReporter).toBeTypeOf(
					"function",
				),
			);

			let rejectPredecessor!: (error: Error) => void;
			const predecessorRetirement = new Promise<void>((_resolve, reject) => {
				rejectPredecessor = reject;
			});
			mocks.structuredSurfaceRetirementReporter?.(predecessorRetirement);
			rejectPredecessor(new Error("predecessor detach failed"));
			await act(async () => {
				await predecessorRetirement.catch(() => {});
			});

			await vi.waitFor(() =>
				expect(mocks.closeRequested).toBeTypeOf("function"),
			);
			await act(async () => {
				await mocks.closeRequested?.({ preventDefault: vi.fn() });
			});

			expect(mocks.markLargeSurfaceRetired).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(
				"[hmux] failed to retire the large structured surface",
				expect.any(Error),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("closes without advancing the return timeout when the exact source acknowledges", async () => {
		const actual = await vi.importActual<
			typeof import("@/lib/workspace/window/largeViewReturnHandoff")
		>("@/lib/workspace/window/largeViewReturnHandoff");
		let readyListener: ((payload: unknown) => void) | undefined;
		let prepareListener: ((payload: unknown) => void) | undefined;
		const requestBackend: LargeViewReturnLifecycleRequestBackend = {
			listenReady: async (listener) => {
				readyListener = listener;
				return () => {};
			},
			emitPrepare: async (_targetWindowLabel, payload) => {
				prepareListener?.(payload);
			},
			emitRetired: vi.fn(async () => {}),
		};
		const sourceBackend: LargeViewReturnSourceBackend = {
			listenPrepare: async (listener) => {
				prepareListener = listener;
				return () => {};
			},
			emitReady: vi.fn(async (_windowLabel, payload) => {
				readyListener?.(payload);
			}),
		};
		const visibility = { conceal: vi.fn(), reveal: vi.fn() };
		const transaction = new LargeViewReturnSourceTransaction(visibility);
		const stopSource = actual.subscribeLargeViewReturnPreparation(
			{
				workspaceId: "workspace-1",
				sessionId: "session-1",
				sourcePaneOwnerId: "desktop-2:agent:1",
			},
			(generation) => {
				if (!transaction.prepare(generation)) return false;
				return () => transaction.complete(generation);
			},
			sourceBackend,
			() => Date.now(),
		);
		await vi.waitFor(() => expect(prepareListener).toBeTypeOf("function"));
		mocks.beginLargeViewReturnToWindow.mockImplementation(
			(identity, replyWindowLabel, targetWindowLabel) =>
				actual.beginLargeViewReturnToWindow(
					identity,
					replyWindowLabel,
					targetWindowLabel,
					requestBackend,
				),
		);
		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:1"
			/>,
		);
		await vi.waitFor(() => expect(mocks.closeRequested).toBeTypeOf("function"));

		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		try {
			await act(async () => {
				await mocks.closeRequested?.({ preventDefault: vi.fn() });
			});

			expect(Date.now()).toBe(10_000);
			expect(sourceBackend.emitReady).toHaveBeenCalledOnce();
			expect(visibility.conceal).toHaveBeenCalledOnce();
			expect(mocks.close).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
			stopSource();
			transaction.dispose();
		}
	});

	it("coalesces repeated native close requests into one return transaction", async () => {
		let acknowledge!: (value: PreparedLargeViewReturn | undefined) => void;
		mocks.beginLargeViewReturnToWindow.mockImplementation(
			() =>
				new Promise((resolve) => {
					acknowledge = resolve;
				}),
		);
		render(
			<AgentSessionWindowRoot
				agentId="agent-1"
				sourceWindowLabel="win-workspace-2"
				sourcePaneOwnerId="desktop-2:agent:1"
			/>,
		);
		await vi.waitFor(() => expect(mocks.closeRequested).toBeTypeOf("function"));
		const firstPreventDefault = vi.fn();
		const secondPreventDefault = vi.fn();

		const first = mocks.closeRequested?.({
			preventDefault: firstPreventDefault,
		});
		await vi.waitFor(() =>
			expect(mocks.beginLargeViewReturnToWindow).toHaveBeenCalledOnce(),
		);
		const second = mocks.closeRequested?.({
			preventDefault: secondPreventDefault,
		});

		expect(mocks.beginLargeViewReturnToWindow).toHaveBeenCalledOnce();
		expect(firstPreventDefault).toHaveBeenCalledOnce();
		expect(secondPreventDefault).toHaveBeenCalledOnce();
		acknowledge({
			generation: "return-coalesced",
			markLargeSurfaceRetired: mocks.markLargeSurfaceRetired,
		});
		await act(async () => {
			await Promise.all([first, second]);
		});
		expect(mocks.markLargeSurfaceRetired).toHaveBeenCalledOnce();
		expect(mocks.restoreWindowAfterSecondaryClose).toHaveBeenCalledOnce();
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});
