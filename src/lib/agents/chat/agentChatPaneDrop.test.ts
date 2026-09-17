// @vitest-environment jsdom

import type { Options } from "@tauri-apps/api/event";
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import { handleCliAgentInput } from "@/lib/cli/cliAgentInput";
import type { CliRequest } from "@/lib/hmux/remote/remoteHmuxShellCliRequest";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { onDesktopPrewarmRequest } from "@/lib/workspace/desktop/desktopPrewarm";
import { movePanelsToDesktop } from "@/lib/workspace/dock";
import { movePanelToDesktopDrop } from "@/lib/workspace/pane/paneDropCoordinator";
import {
	requestAgentSessionCredentialCommand,
	requestAgentSessionForkPresentation,
	requestAgentSessionPaneDrop,
	subscribeAgentSessionWindowCommands,
} from "@/lib/workspace/window/agentSessionWindowCommand";
import { executeAgentSessionWindowCommand } from "@/lib/workspace/window/agentSessionWindowCommandRuntime";
import { installMountedPaneWindowReporter } from "@/lib/workspace/window/mountedPaneWindow";
import type { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { deliverAgentChatDraft } from "./agentChatDraftDelivery";
import { prepareAgentChatDraftTarget } from "./agentChatDraftInput";
import { recoverAgentChatDraftMove } from "./agentChatDraftMoveRecovery";
import {
	agentChatDraftKey,
	createAgentChatDraftStoreSlice,
} from "./agentChatDraftStoreSlice";
import { parseAgentChatPaneDropRequest } from "./agentChatPaneDropRequest";

type State = ReturnType<typeof useStore.getState>;
interface FixtureWindow {
	store: StoreApi<State>;
	docks: Map<string, DockviewApi>;
	moving: Set<string>;
}
const native = await vi.hoisted(async () => {
	const { AsyncLocalStorage } = await import("node:async_hooks");
	return {
		context: new AsyncLocalStorage<string>(),
		windows: new Map<string, FixtureWindow>(),
		listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
		queues: new Map<string, Promise<void>>(),
		seed: null as unknown as State,
		layouts: {} as Record<string, unknown>,
		commands: [] as Array<Record<string, unknown>>,
		cliClaims: new Map<string, string>(),
		cliRequests: [] as CliRequest[],
		cliResults: [] as Array<ReturnType<typeof handleCliAgentInput>>,
		beforeCliClaim: null as null | (() => void),
		credentialEffects: [] as Array<Record<string, unknown>>,
		beforeSourceCommand: null as null | (() => void),
		beforeDesktopReady: null as null | (() => void),
		missingSample: false,
		lostAction: "",
		failFlush: false,
		beforeDrop: null as null | (() => void),
		beforeAppend: null as null | (() => void),
		afterSample: null as null | (() => void),
	};
});
vi.mock("@/lib/agents/agentCredentialTransition", () => ({
	requestAgentCredentialTransition: async (input: Record<string, unknown>) => {
		native.credentialEffects.push({
			action: "switch",
			...input,
			window: native.context.getStore(),
		});
		return { kind: "completed", conversationId: "same-conversation" };
	},
}));
vi.mock("@/lib/sessions/credentials/deferredCredentialSwitchRuntime", () => ({
	applyDeferredCredentialSwitchNow: async (agentId: string) => {
		native.credentialEffects.push({
			action: "apply_pending",
			agentId,
			window: native.context.getStore(),
		});
	},
	cancelDeferredCredentialSwitch: (agentId: string) => {
		native.credentialEffects.push({
			action: "cancel_pending",
			agentId,
			window: native.context.getStore(),
		});
		return true;
	},
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({
	claimCliRequest: async (id: string) => {
		if (native.cliClaims.has(id)) return false;
		native.cliClaims.set(id, native.context.getStore() ?? "main");
		native.beforeCliClaim?.();
		return true;
	},
}));
vi.mock("@/store", async (original) => {
	const actual = await original<typeof import("@/store")>();
	native.seed = actual.useStore.getState();
	const current = () =>
		native.windows.get(native.context.getStore() ?? "main")?.store ??
		actual.useStore;
	return {
		...actual,
		useStore: {
			getState: () => current().getState(),
			setState: (...args: Parameters<typeof useStore.setState>) =>
				current().setState(...args),
		},
		durableAppStorage: {
			...actual.durableAppStorage,
			flush: async () => {
				if (
					native.failFlush &&
					native.context.getStore() === "win-100-2" &&
					Object.values(current().getState().chatDraftMoveReceipts).some(
						(r) => r.status === "moved",
					)
				) {
					native.failFlush = false;
					throw new Error(
						"injected destination persistence acknowledgement loss",
					);
				}
			},
		},
	};
});
vi.mock("@/lib/workspace/dock/dockRegistry", async (original) => {
	const actual =
		await original<typeof import("@/lib/workspace/dock/dockRegistry")>();
	const current = () => native.windows.get(native.context.getStore() ?? "main");
	const docks = new Proxy(new Map<string, DockviewApi>(), {
		get: (target, key) => {
			const map = current()?.docks ?? target;
			const value = Reflect.get(map, key);
			return typeof value === "function" ? value.bind(map) : value;
		},
	});
	const moving = new Proxy(new Set<string>(), {
		get: (target, key) => {
			const set = current()?.moving ?? target;
			const value = Reflect.get(set, key);
			return typeof value === "function" ? value.bind(set) : value;
		},
	});
	return {
		...actual,
		dockviewRegistry: docks,
		movingPanels: moving,
		getDockview: (id: string) => docks.get(id),
		waitForDesktopDockview: async (id: string) => {
			native.beforeDesktopReady?.();
			return docks.get(id);
		},
		mountedDockviewEntries: () => [...docks.entries()],
	};
});
vi.mock("@/lib/workspace/pane/paneMoveQueue", () => ({
	enqueuePaneMove: <T>(task: () => Promise<T>) => {
		const label = native.context.getStore() ?? "main";
		const result = (native.queues.get(label) ?? Promise.resolve()).then(task);
		native.queues.set(
			label,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	},
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({
		label: native.context.getStore() ?? "main",
	}),
	getAllWebviewWindows: async () =>
		[...native.windows.keys()].map((label) => ({ label })),
}));
vi.mock("@/lib/platform/tauriBridge", async (original) => ({
	...(await original<typeof import("@/lib/platform/tauriBridge")>()),
	listenWhenReady: async (
		event: string,
		receive: (event: { payload: unknown }) => void,
		options?: Options,
	) => {
		const label = native.context.getStore() ?? "main";
		const target = options?.target;
		const scope =
			typeof target === "string"
				? target
				: target && "label" in target
					? target.label
					: "*";
		const key = `${scope}:${event}`;
		const listeners = native.listeners.get(key) ?? new Set();
		native.listeners.set(key, listeners);
		const bound = (event: { payload: unknown }) =>
			native.context.run(label, () => receive(event));
		listeners.add(bound);
		return () => listeners.delete(bound);
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	emit: async () => {},
	listen: async () => () => {},
	emitTo: async (
		target: { label: string },
		event: string,
		value: Record<string, unknown>,
	) => {
		const payload = JSON.parse(JSON.stringify(value));
		if (event === "cli:request") native.cliRequests.push(payload);
		if (event === "dure://pane-owner/response") native.afterSample?.();
		if (
			native.missingSample &&
			event === "dure://pane-owner/response" &&
			native.context.getStore() === "win-100-2"
		)
			return;
		if (event.endsWith("/source-command")) {
			native.commands.push(payload);
			native.context.run(target.label, () => native.beforeSourceCommand?.());
			if (payload.action === "drop_chat_pane")
				native.context.run(target.label, () => native.beforeDrop?.());
			if (payload.action === "append_draft")
				native.context.run(target.label, () => native.beforeAppend?.());
		}
		if (event.endsWith("/source-command-result")) {
			const command = native.commands.find(
				(candidate) => candidate.generation === payload.generation,
			);
			if (command?.action === native.lostAction) return;
		}
		// Tauri delivers targeted events to Any subscriptions in every WebView too.
		for (const scope of ["*", target.label])
			for (const receive of native.listeners.get(`${scope}:${event}`) ?? [])
				receive({ payload });
	},
}));
vi.mock("@/lib/workspace/layout/layoutPushChannel", () => ({
	publishLayoutPush: () => {
		for (const [label, window] of native.windows)
			native.context.run(label, () => {
				window.store.setState({ layouts: native.layouts });
				for (const [desktopId, api] of window.docks)
					if (native.layouts[desktopId])
						api.fromJSON(
							native.layouts[desktopId] as Parameters<
								DockviewApi["fromJSON"]
							>[0],
							{ reuseExistingPanels: true },
						);
			});
	},
}));
vi.mock("@/lib/persistence/durableAppStateSettlement", () => ({
	settleDurableAppState: async () => {
		const window = native.windows.get(native.context.getStore() ?? "main");
		window?.store.setState({ layouts: native.layouts });
		return {};
	},
}));
vi.mock("@/lib/persistence/currentDurableProjectionRecovery", () => ({
	recoverCurrentDurableStoreProjection: async () => {
		const window = native.windows.get(native.context.getStore() ?? "main");
		if (!window) return false;
		window.store.setState({ layouts: native.layouts });
		for (const [desktopId, api] of window.docks)
			if (native.layouts[desktopId])
				api.fromJSON(
					native.layouts[desktopId] as Parameters<DockviewApi["fromJSON"]>[0],
					{ reuseExistingPanels: true },
				);
		return true;
	},
}));
const identity = {
	agentId: "drag-chat",
	backendProfileId: "local",
	interactionSessionId: "drag-conversation",
};
const panelId = `agent:${identity.agentId}`;
const key = agentChatDraftKey(identity);
const image = { fileName: "드래그.png", dataB64: "cHJlc2VydmVkLWJ5dGVz" };
const stops: Array<() => void> = [];
function windowFixture(label: string, desktopId: string): FixtureWindow {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(800, 600);
	const store = createStore<State>((set) => ({
		...native.seed,
		...createAgentChatDraftStoreSlice(set),
		agents: [
			managedAgentFixture({
				id: identity.agentId,
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: identity.backendProfileId,
					interactionSessionId: identity.interactionSessionId,
				},
			}),
		],
		spaces: [
			{ id: "source", name: "Source" },
			{ id: "target", name: "Target" },
		],
		activeSpaceId: desktopId,
		projects: [],
		layouts: {},
		saveLayout: (id, layout) =>
			set((state) => ({ layouts: { ...state.layouts, [id]: layout } })),
	}));
	const window = {
		store,
		docks: new Map([[desktopId, api]]),
		moving: new Set<string>(),
	};
	native.windows.set(label, window);
	stops.push(
		store.subscribe((state, old) => {
			if (state.layouts !== old.layouts) {
				const next = { ...native.layouts };
				for (const [id, layout] of Object.entries(state.layouts))
					if (old.layouts[id] !== layout) next[id] = layout;
				for (const id of Object.keys(old.layouts))
					if (!(id in state.layouts)) delete next[id];
				native.layouts = next;
			}
		}),
	);
	stops.push(() => {
		api.dispose();
		element.remove();
	});
	return window;
}
beforeEach(async () => {
	native.windows.clear();
	native.queues.clear();
	native.listeners.clear();
	native.commands = [];
	native.cliClaims.clear();
	native.cliRequests = [];
	native.cliResults = [];
	native.beforeCliClaim = null;
	native.credentialEffects = [];
	native.beforeSourceCommand = null;
	native.beforeDesktopReady = null;
	native.layouts = {};
	native.missingSample = false;
	native.lostAction = "";
	native.failFlush = false;
	native.beforeDrop = null;
	native.beforeAppend = null;
	native.afterSample = null;
	const source = windowFixture("main", "source");
	const target = windowFixture("win-100-2", "target");
	source.docks
		.get("source")!
		.addPanel({ id: panelId, component: "agent", title: "Chat", params: { agentRef: { agentId: identity.agentId } } });
	target.docks.get("target")!.addPanel({
		id: "term:reference",
		component: "terminal",
		title: "Reference",
	});
	const layouts = {
		source: source.docks.get("source")!.toJSON(),
		target: target.docks.get("target")!.toJSON(),
	};
	for (const [label, window] of native.windows)
		await native.context.run(label, async () => {
			window.store.setState({ layouts });
			stops.push(await installMountedPaneWindowReporter());
			stops.push(
				await listenWhenReady<CliRequest>(
					"cli:request",
					({ payload }) => {
						native.cliResults.push(
							handleCliAgentInput(payload.params, payload.reqId),
						);
					},
					{ target: { kind: "WebviewWindow", label } },
				),
			);
			stops.push(
				subscribeAgentSessionWindowCommands(executeAgentSessionWindowCommand),
			);
			await Promise.resolve();
		});
	source.store.getState().updateChatDraft(identity, () => ({
		text: "한글 드래그 초안\n ",
		attachments: [image],
	}));
});
afterEach(() => {
	for (const stop of stops.splice(0).reverse()) stop();
	vi.useRealTimers();
});
function performDrop(
	position?: import("@/lib/workspace/pane/panePlacement").PanelPosition,
	paneId = panelId,
) {
	return native.context.run("win-100-2", () =>
		movePanelToDesktopDrop(
			{ panelId: paneId, fromDesktopId: "source" },
			"target",
			position ?? {
				direction: "right",
				referenceGroup: native.windows
					.get("win-100-2")!
					.docks.get("target")!
					.getPanel("term:reference")!.group,
			},
		),
	);
}
function source() {
	return native.windows.get("main")!;
}
function target() {
	return native.windows.get("win-100-2")!;
}

function replaceSourcePane(
	id: string,
	component = "agent",
	params: Record<string, unknown> = { agentRef: { agentId: identity.agentId } },
) {
	const api = source().docks.get("source")!;
	api.removePanel(api.getPanel(panelId)!);
	api.addPanel({ id, component, params });
	const layouts = { ...native.layouts, source: api.toJSON() };
	for (const window of native.windows.values())
		window.store.setState({ layouts });
}

function appendFrom(label: string) {
	return native.context.run(label, () =>
		deliverAgentChatDraft(
			prepareAgentChatDraftTarget(source().store.getState().agents[0]),
			"한글 캡처\n ",
			[image],
		),
	);
}

function enableCaptureAttachments() {
	for (const window of native.windows.values()) {
		const agent = window.store.getState().agents[0];
		window.store.setState({
			projects: [
				{
					id: agent.projectId,
					name: "Chat",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
		});
	}
}

const credentialActions = [
	"switch",
	"apply_pending",
	"cancel_pending",
] as const;
function credentialFromPeer(
	action: (typeof credentialActions)[number],
	id: string,
) {
	return native.context.run("win-100-2", () =>
		requestAgentSessionCredentialCommand({
			action,
			agentId: identity.agentId,
			targetCredentialId: "account-2",
			sourceWindowLabel: "main",
			sourcePaneOwnerId: `source:${id}`,
		}),
	);
}

it.each(
	credentialActions.flatMap((action) =>
		[panelId, "pane:opaque", "launcher:slot", "agent:other"].map((id) => ({
			action,
			id,
		})),
	),
)(
	"routes $action to the current Agent in $id in its owning window",
	async ({ action, id }) => {
		replaceSourcePane(id);
		const before = source().docks.get("source")!.toJSON();
		const drafts = source().store.getState().chatDrafts;
		const result = await credentialFromPeer(action, id);
		expect(result).toEqual(
			action === "switch"
				? { kind: "completed", conversationId: "same-conversation" }
				: action === "apply_pending"
					? { kind: "applied" }
					: { kind: "cancelled", cancelled: true },
		);
		expect(native.credentialEffects).toEqual([
			{
				action,
				agentId: identity.agentId,
				window: "main",
				...(action === "switch"
					? { targetCredentialId: "account-2", sourcePanelId: id }
					: {}),
			},
		]);
		expect(source().docks.get("source")!.toJSON()).toEqual(before);
		expect(source().store.getState().chatDrafts).toBe(drafts);
		expect(target().store.getState().chatDrafts).toEqual({});
	},
);

it.each(
	credentialActions.flatMap((action) =>
		["retargeted", "cleared", "terminal", "removed"].map((change) => ({
			action,
			change,
		})),
	),
)(
	"does not execute $action when the ID-named pane is $change before delivery",
	async ({ action, change }) => {
		const api = source().docks.get("source")!;
		const drafts = source().store.getState().chatDrafts;
		native.beforeSourceCommand = () => {
			const pane = api.getPanel(panelId)!;
			if (change === "removed") api.removePanel(pane);
			else if (change === "terminal") replaceSourcePane(panelId, "terminal");
			else
				pane.api.updateParameters({
					agentRef: change === "cleared" ? null : { agentId: "other" },
				});
		};
		await expect(credentialFromPeer(action, panelId)).rejects.toThrow(
			"credential command source Agent mismatch",
		);
		expect(native.credentialEffects).toEqual([]);
		expect(source().store.getState().chatDrafts).toBe(drafts);
		expect(target().store.getState().chatDrafts).toEqual({});
	},
);

function installForkPane(id: string) {
	const fork = managedAgentFixture({ id: "forked-agent" });
	for (const window of native.windows.values())
		window.store.setState({
			agents: [...window.store.getState().agents, fork],
		});
	const api = source().docks.get("source")!;
	api.addPanel({
		id,
		component: "agent",
		params: { agentRef: { agentId: fork.id } },
	});
	source().store.getState().saveLayout("source", api.toJSON());
	return fork;
}

function presentForkFromPeer(sourceId: string) {
	return native.context.run("win-100-2", () =>
		requestAgentSessionForkPresentation({
			agentId: identity.agentId,
			forkedAgentId: "forked-agent",
			sourceWindowLabel: "main",
			sourcePaneOwnerId: `source:${sourceId}`,
		}),
	);
}

it.each([
	{ sourceId: panelId, forkId: "pane:fork" },
	{ sourceId: "pane:source", forkId: "launcher:fork" },
	{ sourceId: "launcher:source", forkId: "agent:old-fork" },
])(
	"presents and reuses fork $forkId from $sourceId across windows",
	async ({ sourceId, forkId }) => {
		replaceSourcePane(sourceId);
		installForkPane(forkId);
		const api = source().docks.get("source")!;
		const panes = [...api.panels];
		const drafts = source().store.getState().chatDrafts;
		const peerBefore = target().docks.get("target")!.toJSON();
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(presentForkFromPeer(sourceId)).resolves.toEqual({
				kind: "presented",
			});
			expect(api.activePanel?.id).toBe(forkId);
			expect(api.panels).toEqual(panes);
			expect(source().store.getState().chatDrafts).toBe(drafts);
			expect(target().docks.get("target")!.toJSON()).toEqual(peerBefore);
		}
		expect(native.credentialEffects).toEqual([]);
	},
);

it("does not present a fork when the source Agent changed before the cross-window command arrives", async () => {
	installForkPane("agent:forked-agent");
	native.beforeSourceCommand = () => {
		const api = source().docks.get("source")!;
		api
			.getPanel(panelId)!
			.api.updateParameters({ agentRef: { agentId: "other" } });
		source().store.getState().saveLayout("source", api.toJSON());
	};
	await expect(presentForkFromPeer(panelId)).rejects.toThrow();
	expect(native.credentialEffects).toEqual([]);
});

it("does not present a fork after the source changes while its desktop becomes ready", async () => {
	installForkPane("agent:forked-agent");
	const api = source().docks.get("source")!;
	native.beforeDesktopReady = () => {
		api.getPanel(panelId)!.api.updateParameters({ agentRef: null });
		source().store.getState().saveLayout("source", api.toJSON());
	};
	await expect(presentForkFromPeer(panelId)).rejects.toThrow();
	expect(api.getPanel(panelId)?.params?.agentRef).toBeNull();
});

it.each(
	["main", "win-100-2"].flatMap((label) =>
		[panelId, "pane:opaque", "launcher:slot", "agent:other"].map((id) => ({
			label,
			id,
		})),
	),
)(
	"appends from $label to current Agent content in $id without creating a sender draft",
	async ({ label, id }) => {
		replaceSourcePane(id);
		enableCaptureAttachments();
		const api = source().docks.get("source")!;
		api
			.getPanel(id)!
			.api.updateParameters({ titleHint: "model params changed" });
		const before = source().store.getState().chatDrafts[identity.agentId][key];
		await appendFrom(label);
		expect(source().store.getState().chatDrafts[identity.agentId][key]).toEqual(
			{
				text: `${before.text}\n\n한글 캡처\n `,
				attachments: [...before.attachments, image],
			},
		);
		expect(target().store.getState().chatDrafts).toEqual({});
		expect(native.commands.map((command) => command.action)).toEqual(
			label === "main" ? [] : ["append_draft"],
		);
	},
);

it.each(["main", "win-100-2"])(
	"does not treat Agent-shaped terminal content as an append recipient from %s",
	async (label) => {
		replaceSourcePane(panelId, "terminal");
		enableCaptureAttachments();
		const before = source().store.getState().chatDrafts;
		await expect(appendFrom(label)).rejects.toThrow("Open the chat pane");
		expect(source().store.getState().chatDrafts).toBe(before);
		expect(target().store.getState().chatDrafts).toEqual({});
		expect(native.commands).toEqual([]);
	},
);

it("keeps both drafts when the selected pane is retargeted before an append command arrives", async () => {
	enableCaptureAttachments();
	const original = source().store.getState().agents[0];
	const other = { ...original, id: "other" };
	source().store.setState({ agents: [original, other] });
	native.context.run("main", () =>
		source()
			.store.getState()
			.updateChatDraft(prepareAgentChatDraftTarget(other).identity, () => ({
				text: "Keep other",
				attachments: [],
			})),
	);
	const before = source().store.getState().chatDrafts;
	native.beforeAppend = () =>
		source()
			.docks.get("source")!
			.getPanel(panelId)!
			.api.updateParameters({ agentRef: { agentId: other.id } });
	await expect(appendFrom("win-100-2")).rejects.toThrow("recipient changed");
	expect(source().store.getState().chatDrafts).toBe(before);
	expect(target().store.getState().chatDrafts).toEqual({});
	expect(native.commands).toHaveLength(1);
});

it("does not choose the ID-named pane when two current panes reference the same Agent", async () => {
	enableCaptureAttachments();
	const api = source().docks.get("source")!;
	api.addPanel({
		id: "pane:second",
		component: "agent",
		params: { agentRef: { agentId: identity.agentId } },
	});
	source().store.setState({
		layouts: { ...native.layouts, source: api.toJSON() },
	});
	const before = source().store.getState().chatDrafts;
	await expect(appendFrom("win-100-2")).rejects.toMatchObject({
		code: "pane_ambiguous",
	});
	expect(source().store.getState().chatDrafts).toBe(before);
	expect(native.commands).toEqual([]);
});

it("preserves the local draft when its pane is retargeted while observing another window", async () => {
	enableCaptureAttachments();
	const before = source().store.getState().chatDrafts;
	native.afterSample = () =>
		source()
			.docks.get("source")!
			.getPanel(panelId)!
			.api.updateParameters({ agentRef: null });
	await expect(appendFrom("main")).rejects.toThrow("recipient changed");
	expect(source().store.getState().chatDrafts).toBe(before);
	expect(target().store.getState().chatDrafts).toEqual({});
	expect(native.commands).toEqual([]);
});

it("keeps an unanswered window unknown before appending locally", async () => {
	enableCaptureAttachments();
	native.missingSample = true;
	const before = source().store.getState().chatDrafts;
	await expect(appendFrom("main")).rejects.toThrow("did not report");
	expect(source().store.getState().chatDrafts).toBe(before);
	expect(native.commands).toEqual([]);
});

it("does not append while a neutral pane is moving", async () => {
	enableCaptureAttachments();
	replaceSourcePane("pane:moving");
	source().moving.add("pane:moving");
	const before = source().store.getState().chatDrafts;
	await expect(appendFrom("win-100-2")).rejects.toThrow("moving");
	expect(source().store.getState().chatDrafts).toBe(before);
	expect(native.commands).toEqual([]);
});

it.each(["pane:opaque", "launcher:slot", "terminal:slot", "agent:old-owner"])(
	"moves the current chat draft for %s without deriving its Agent from the pane ID",
	async (id) => {
		replaceSourcePane(id);
		const before = source().store.getState().chatDrafts[identity.agentId];
		expect((await performDrop(undefined, id)).movedPanelIds).toEqual([id]);
		expect(target().store.getState().chatDrafts[identity.agentId]).toEqual(
			before,
		);
		expect(
			source().store.getState().chatDrafts[identity.agentId],
		).toBeUndefined();
		expect(
			target().docks.get("target")!.getPanel(id)!.params?.agentRef,
		).toEqual({ agentId: identity.agentId });
		expect(
			native.commands.map((command) =>
				command.action === "draft_move" ? command.step : command.action,
			),
		).toEqual(["move_chat_pane", "stage", "drop_chat_pane", "commit"]);
	},
);

it("moves only the referenced Agent's draft when the ID-named Agent also has a draft", async () => {
	const current = {
		...identity,
		agentId: "current-chat",
		interactionSessionId: "current-conversation",
	};
	for (const window of native.windows.values()) {
		const agent = window.store.getState().agents[0];
		window.store.setState({
			agents: [
				agent,
				{
					...agent,
					id: current.agentId,
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: current.backendProfileId,
						interactionSessionId: current.interactionSessionId,
					},
				},
			],
		});
	}
	source()
		.store.getState()
		.updateChatDraft(current, () => ({
			text: "current draft",
			attachments: [image],
		}));
	replaceSourcePane(panelId, "agent", {
		agentRef: { agentId: current.agentId },
	});
	const original = source().store.getState().chatDrafts[identity.agentId];
	const moved = source().store.getState().chatDrafts[current.agentId];
	expect((await performDrop()).movedPanelIds).toEqual([panelId]);
	expect(target().store.getState().chatDrafts[current.agentId]).toEqual(moved);
	expect(source().store.getState().chatDrafts[current.agentId]).toBeUndefined();
	expect(source().store.getState().chatDrafts[identity.agentId]).toBe(original);
	expect(
		target().store.getState().chatDrafts[identity.agentId],
	).toBeUndefined();
});

it.each(["terminal", "launcher", "unknown"])(
	"does not transfer an unrelated chat draft for Agent-shaped %s content",
	async (component) => {
		replaceSourcePane(panelId, component);
		const before = source().store.getState().chatDrafts[identity.agentId];
		expect((await performDrop()).movedPanelIds).toEqual([panelId]);
		expect(source().store.getState().chatDrafts[identity.agentId]).toBe(before);
		expect(target().store.getState().chatDrafts).toEqual({});
		expect(native.commands).toEqual([]);
	},
);

it("rejects a stale source reference before staging even if the requested Agent still exists", async () => {
	source()
		.docks.get("source")!
		.getPanel(panelId)!
		.api.updateParameters({ agentRef: { agentId: "replacement" } });
	const before = source().store.getState().chatDrafts[identity.agentId];
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect((await performDrop()).movedPanelIds).toEqual([]);
		expect(source().docks.get("source")!.getPanel(panelId)).toBeDefined();
		expect(source().store.getState().chatDrafts[identity.agentId]).toBe(before);
		expect(target().store.getState().chatDrafts).toEqual({});
		expect(native.commands.map((command) => command.action)).toEqual([
			"move_chat_pane",
		]);
	} finally {
		log.mockRestore();
	}
});

it("keeps the source when the destination already has different content under the same pane ID", async () => {
	target()
		.docks.get("target")!
		.addPanel({ id: panelId, component: "terminal" });
	const before = source().store.getState().chatDrafts[identity.agentId];
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect((await performDrop()).movedPanelIds).toEqual([]);
		expect(source().docks.get("source")!.getPanel(panelId)).toBeDefined();
		expect(source().store.getState().chatDrafts[identity.agentId]).toBe(before);
		expect(target().store.getState().chatDrafts).toEqual({});
		expect(target().docks.get("target")!.getPanel(panelId)!.api.component).toBe(
			"terminal",
		);
	} finally {
		log.mockRestore();
	}
});

it("moves a remote-source draft through actual window commands while keeping the target's native drop placement", async () => {
	source()
		.docks.get("source")!
		.getPanel(panelId)!
		.api.setTitle("Edited before layout debounce");
	const receipt = await performDrop();
	expect(receipt.movedPanelIds).toEqual([panelId]);
	expect(target().store.getState().chatDrafts[identity.agentId]).toEqual({
		[key]: { text: "한글 드래그 초안\n ", attachments: [image] },
	});
	expect(
		source().store.getState().chatDrafts[identity.agentId],
	).toBeUndefined();
	expect(source().docks.get("source")!.getPanel(panelId)).toBeUndefined();
	const panel = target().docks.get("target")!.getPanel(panelId)!;
	expect(panel.title).toBe("Edited before layout debounce");
	expect(panel.group.id).not.toBe(
		target().docks.get("target")!.getPanel("term:reference")!.group.id,
	);
	expect(
		native.commands.map((command) =>
			command.action === "draft_move" ? command.step : command.action,
		),
	).toEqual(["move_chat_pane", "stage", "drop_chat_pane", "commit"]);
});

it("keeps the shared draft when a drop moves between two Spaces in the same window", async () => {
	source().docks.set("target", target().docks.get("target")!);
	native.windows.delete("win-100-2");
	const original = source().store.getState().chatDrafts[identity.agentId];
	const receipt = await native.context.run("main", () =>
		movePanelToDesktopDrop({ panelId, fromDesktopId: "source" }, "target", {
			direction: "right",
		}),
	);
	expect(receipt.movedPanelIds).toEqual([panelId]);
	expect(source().store.getState().chatDrafts[identity.agentId]).toBe(original);
	expect(source().docks.get("source")!.getPanel(panelId)).toBeUndefined();
	expect(source().docks.get("target")!.getPanel(panelId)).toBeDefined();
	expect(native.commands).toEqual([]);
});

it("refuses a stale local source projection that no longer owns the durable pane", async () => {
	source().docks.set("target", target().docks.get("target")!);
	native.windows.delete("win-100-2");
	source()
		.store.getState()
		.saveLayout("source", { grid: { root: null }, panels: {} });
	const original = source().store.getState().chatDrafts[identity.agentId];
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const receipt = await native.context.run("main", () =>
			movePanelToDesktopDrop({ panelId, fromDesktopId: "source" }, "target", {
				direction: "right",
			}),
		);
		expect(receipt.movedPanelIds).toEqual([]);
		expect(source().store.getState().chatDrafts[identity.agentId]).toBe(
			original,
		);
		expect(source().docks.get("source")!.getPanel(panelId)).toBeDefined();
		expect(source().docks.get("target")!.getPanel(panelId)).toBeUndefined();
		expect(native.commands).toEqual([]);
	} finally {
		log.mockRestore();
	}
});

it.each([panelId, "pane:opaque"])(
	"recovers a lost drop reply for %s without moving the pane again",
	async (id) => {
		if (id !== panelId) replaceSourcePane(id);
		native.lostAction = "drop_chat_pane";
		vi.useFakeTimers();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = performDrop(undefined, id);
		try {
			await vi.waitFor(() =>
				expect(
					native.commands.some(
						(command) => command.action === "drop_chat_pane",
					),
				).toBe(true),
			);
			await vi.advanceTimersByTimeAsync(240_001);
			expect((await pending).movedPanelIds).toEqual([]);
			const move = source().store.getState().chatDraftMoves[identity.agentId];
			expect(
				target().store.getState().chatDraftMoveReceipts[move.transfer.id]
					.status,
			).toBe("moved");
			expect(
				source().store.getState().chatDrafts[identity.agentId][key].text,
			).toBe("한글 드래그 초안\n ");
			expect(
				target().store.getState().chatDrafts[identity.agentId],
			).toBeUndefined();
			const done = await native.context.run("win-100-2", () =>
				recoverAgentChatDraftMove({
					transfer: move.transfer,
					intent: "finish",
				}),
			);
			expect(done.status).toBe("committed");
			expect(
				target().store.getState().chatDrafts[identity.agentId][key],
			).toEqual({ text: "한글 드래그 초안\n ", attachments: [image] });
			expect(
				source().store.getState().chatDrafts[identity.agentId],
			).toBeUndefined();
			expect(
				native.commands.filter(
					(command) => command.action === "drop_chat_pane",
				),
			).toHaveLength(1);
		} finally {
			await vi.advanceTimersByTimeAsync(240_001);
			await pending;
			log.mockRestore();
		}
	},
);

it("keeps source composition after target-group rejection and lets the user cancel the staged move from the target", async () => {
	native.beforeDrop = () => {
		const api = target().docks.get("target")!;
		api.removePanel(api.getPanel("term:reference")!);
		target().store.getState().saveLayout("target", api.toJSON());
	};
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect((await performDrop()).movedPanelIds).toEqual([]);
		expect(source().docks.get("source")!.getPanel(panelId)).toBeDefined();
		const move = target().store.getState().chatDraftMoves[identity.agentId];
		expect(move.role).toBe("destination");
		const result = await native.context.run("win-100-2", () =>
			recoverAgentChatDraftMove({ transfer: move.transfer, intent: "cancel" }),
		);
		expect(result.status).toBe("aborted");
		expect(target().store.getState().chatDraftMoves).toEqual({});
		expect(source().store.getState().chatDraftMoves).toEqual({});
		expect(source().store.getState().chatDrafts[identity.agentId][key]).toEqual(
			{ text: "한글 드래그 초안\n ", attachments: [image] },
		);
		source()
			.store.getState()
			.updateChatDraft(identity, (draft) => ({ ...draft, text: "계속 작성" }));
	} finally {
		log.mockRestore();
	}
});

it("preserves newer native placement and draft edits when the recorded drop command is replayed", async () => {
	await performDrop();
	const request = parseAgentChatPaneDropRequest(
		native.commands.find((command) => command.action === "drop_chat_pane"),
	);
	if (!request) throw new Error("missing drop packet");
	const api = target().docks.get("target")!;
	api.getPanel(panelId)!.api.setTitle("Edited after delivery without debounce");
	target()
		.store.getState()
		.updateChatDraft(identity, (draft) => ({ ...draft, text: "받은 뒤 편집" }));
	const before = api.toJSON();
	await native.context.run("main", () => requestAgentSessionPaneDrop(request));
	expect(api.toJSON()).toEqual(before);
	expect(target().store.getState().chatDrafts[identity.agentId][key].text).toBe(
		"받은 뒤 편집",
	);
	await expect(
		native.context.run("main", () =>
			requestAgentSessionPaneDrop({
				...request,
				position: { direction: "left" },
			}),
		),
	).rejects.toThrow("changed");
	expect(api.toJSON()).toEqual(before);
});

it("retains a moved snapshot through persistence-acknowledgement failure and finishes it explicitly", async () => {
	native.failFlush = true;
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect((await performDrop()).movedPanelIds).toEqual([]);
		const move = source().store.getState().chatDraftMoves[identity.agentId];
		expect(
			target().store.getState().chatDraftMoveReceipts[move.transfer.id].status,
		).toBe("moved");
		await expect(
			native.context.run("win-100-2", () =>
				recoverAgentChatDraftMove({
					transfer: move.transfer,
					intent: "cancel",
				}),
			),
		).rejects.toThrow("changed");
		expect(
			source().store.getState().chatDrafts[identity.agentId][key].text,
		).toBe("한글 드래그 초안\n ");
		expect(
			(
				await native.context.run("win-100-2", () =>
					recoverAgentChatDraftMove({
						transfer: move.transfer,
						intent: "finish",
					}),
				)
			).status,
		).toBe("committed");
		expect(
			native.commands.filter((command) => command.action === "drop_chat_pane"),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
	}
});

function admitColdWorkspace() {
	for (const window of native.windows.values())
		window.store.setState((state) => ({
			spaces: [...state.spaces, { id: "cold", name: "Cold" }],
		}));
	const admitted = vi.fn((id: string) => {
		expect(id).toBe("cold");
		expect(native.context.getStore()).toBe("main");
		const element = document.createElement("div");
		document.body.append(element);
		const api = createDockview(element, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(800, 600);
		source().docks.set("cold", api);
		stops.push(() => {
			api.dispose();
			element.remove();
		});
	});
	stops.push(onDesktopPrewarmRequest(admitted));
	return admitted;
}
it("asks the canonical prewarm channel for a cold local Space and keeps the shared draft without changing selection", async () => {
	const admitted = admitColdWorkspace();
	const original = source().store.getState().chatDrafts[identity.agentId];
	const receipt = await native.context.run("main", () =>
		movePanelsToDesktop([{ panelId, fromDesktopId: "source" }], "cold"),
	);
	expect(receipt.movedPanelIds).toEqual([panelId]);
	expect(admitted).toHaveBeenCalledOnce();
	expect(source().store.getState().activeSpaceId).toBe("source");
	expect(source().store.getState().chatDrafts[identity.agentId]).toBe(original);
	expect(source().docks.get("cold")!.getPanel(panelId)).toBeDefined();
	expect(native.commands).toEqual([]);
});
it("does not let local prewarming bypass an unanswered peer window", async () => {
	const admitted = admitColdWorkspace();
	native.missingSample = true;
	vi.useFakeTimers();
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const pending = native.context.run("main", () =>
		movePanelsToDesktop([{ panelId, fromDesktopId: "source" }], "cold"),
	);
	try {
		await vi.advanceTimersByTimeAsync(1_501);
		expect((await pending).movedPanelIds).toEqual([]);
		expect(admitted).toHaveBeenCalledOnce();
		expect(source().docks.get("source")!.getPanel(panelId)).toBeDefined();
		expect(
			source().store.getState().chatDrafts[identity.agentId][key].text,
		).toBe("한글 드래그 초안\n ");
		expect(native.commands).toEqual([]);
	} finally {
		await vi.advanceTimersByTimeAsync(6_001);
		await pending;
		log.mockRestore();
	}
});

it("preserves a reference-pane placement used by recent-session moves", async () => {
	const api = target().docks.get("target")!;
	api.addPanel({
		id: "term:other",
		component: "terminal",
		position: { referencePanel: "term:reference", direction: "right" },
	});
	target().store.getState().saveLayout("target", api.toJSON());
	const add = vi.spyOn(api, "addPanel");
	try {
		const position = { referencePanel: "term:reference", direction: "below" };
		expect((await performDrop(position)).movedPanelIds).toEqual([panelId]);
		expect(add).toHaveBeenCalledWith(
			expect.objectContaining({ position: expect.objectContaining(position) }),
		);
		expect(
			native.commands.find((command) => command.action === "drop_chat_pane")
				?.position,
		).toEqual(position);
	} finally {
		add.mockRestore();
	}
});
it("keeps floating geometry through the cross-window drop request", async () => {
	const api = target().docks.get("target")!;
	const add = vi.spyOn(api, "addPanel");
	const position = { floating: { x: 25, y: 30, width: 560, height: 420 } };
	try {
		expect((await performDrop(position)).movedPanelIds).toEqual([panelId]);
		expect(api.getPanel(panelId)!.group.api.location.type).toBe("floating");
		expect(add).toHaveBeenCalledWith(expect.objectContaining(position));
		expect(
			native.commands.find((command) => command.action === "drop_chat_pane")
				?.position,
		).toEqual(position);
	} finally {
		add.mockRestore();
	}
});

it.each(["pane:cli-slot", "launcher:previous", "agent:previous"])(
	"routes CLI drafts through the real window observer to %s without a second window draft",
	async (paneId) => {
		replaceSourcePane(paneId);
		const before = source().store.getState().chatDrafts[identity.agentId][key];
		const params = {
			name: identity.agentId,
			text: "CLI capture\n한글",
			enter: false,
		};
		await expect(
			native.context.run("win-100-2", () =>
				handleCliAgentInput(params, "cli-window-request"),
			),
		).resolves.toBeNull();
		expect(native.cliRequests).toHaveLength(1);
		expect(native.cliRequests[0]).toMatchObject({
			reqId: "cli-window-request",
			params: {
				targetPanelId: paneId,
				paneOwner: { paneId, windowLabel: "main" },
			},
		});
		expect(await Promise.all(native.cliResults)).toMatchObject([
			{
				ok: true,
				input: {
					panelId: paneId,
					agentId: identity.agentId,
					receipt: { delivery: "drafted" },
				},
			},
		]);
		expect([...native.cliClaims]).toEqual([["cli-window-request", "main"]]);
		expect(source().store.getState().chatDrafts[identity.agentId][key]).toEqual(
			{ text: `${before.text}\n\n${params.text}`, attachments: [image] },
		);
		expect(
			target().store.getState().chatDrafts[identity.agentId],
		).toBeUndefined();
		const request = native.cliRequests[0];
		await expect(
			native.context.run("main", () =>
				handleCliAgentInput(request.params, request.reqId),
			),
		).resolves.toBeNull();
		expect(
			source().store.getState().chatDrafts[identity.agentId][key].text,
		).toBe(`${before.text}\n\n${params.text}`);
	},
);

it("refuses a retired window generation in a forwarded CLI draft without appending", async () => {
	replaceSourcePane(panelId);
	await native.context.run("win-100-2", () =>
		handleCliAgentInput(
			{ name: identity.agentId, text: "first", enter: false },
			"first-cli-request",
		),
	);
	await Promise.all(native.cliResults);
	const request = native.cliRequests[0];
	const before = source().store.getState().chatDrafts;
	const owner = request.params.paneOwner as Record<string, unknown>;
	await expect(
		native.context.run("main", () =>
			handleCliAgentInput(
				{
					...request.params,
					paneOwner: { ...owner, windowGeneration: "retired-generation" },
				},
				"retired-cli-request",
			),
		),
	).resolves.toMatchObject({ ok: false, error: { code: "pane_changed" } });
	expect(source().store.getState().chatDrafts).toEqual(before);
	expect(
		target().store.getState().chatDrafts[identity.agentId],
	).toBeUndefined();
});

it("refuses a CLI draft when its mounted pane changes during the broker claim", async () => {
	const paneId = panelId;
	replaceSourcePane(paneId);
	const before = source().store.getState().chatDrafts;
	native.beforeCliClaim = () =>
		source()
			.docks.get("source")!
			.getPanel(paneId)!
			.api.updateParameters({ agentRef: null });
	await native.context.run("win-100-2", () =>
		handleCliAgentInput(
			{ name: identity.agentId, text: "late draft", enter: false },
			"changed-cli-request",
		),
	);
	expect(await Promise.all(native.cliResults)).toMatchObject([
		{ ok: false, error: { code: "pane_changed" } },
	]);
	expect(source().store.getState().chatDrafts).toEqual(before);
	expect(
		target().store.getState().chatDrafts[identity.agentId],
	).toBeUndefined();
	expect([...native.cliClaims]).toEqual([["changed-cli-request", "main"]]);
});
