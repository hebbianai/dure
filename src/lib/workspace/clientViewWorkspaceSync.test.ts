import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientViewStateTransport } from "@/lib/workspace/clientViewState";
import type {
	ClientViewStateSync,
	ClientViewStateSyncOptions,
	ClientViewSyncSnapshot,
} from "@/lib/workspace/clientViewStateSync";
import {
	type ClientViewWorkspaceSyncDependencies,
	createClientViewWorkspaceSyncRuntime,
	dureClientViewSyncHealth,
	installDureClientViewWorkspaceSync,
} from "@/lib/workspace/clientViewWorkspaceSync";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const installMocks = vi.hoisted(() => ({
	readIdentity: vi.fn(),
	createTransport: vi.fn(),
}));

vi.mock("@/lib/ipc/dureClientViewIdentity", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/ipc/dureClientViewIdentity")
	>("@/lib/ipc/dureClientViewIdentity");
	return {
		...actual,
		readDureClientViewLocalIdentity: installMocks.readIdentity,
	};
});

vi.mock("@/lib/ipc/dureClientView", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/ipc/dureClientView")
	>("@/lib/ipc/dureClientView");
	return {
		...actual,
		createDureClientViewStateTransport: installMocks.createTransport,
	};
});

const identity = (clientId: string) => ({
	schemaVersion: 1 as const,
	namespace: { tenantId: "personal", userId: "owner", clientId },
	clientInstanceId: `instance-${clientId}`,
});

function layout(left = 300, right = 700) {
	return {
		grid: {
			root: {
				type: "branch",
				data: [
					{
						type: "leaf",
						size: left,
						data: { id: "left", views: ["term:a"], activeView: "term:a" },
					},
					{
						type: "leaf",
						size: right,
						data: { id: "right", views: ["term:b"], activeView: "term:b" },
					},
				],
			},
			width: 1000,
			height: 600,
			orientation: "HORIZONTAL",
		},
		activeGroup: "left",
		panels: {
			"term:a": {
				contentComponent: "terminal",
				params: { sessionId: "session-a" },
			},
			"term:b": {
				contentComponent: "terminal",
				params: { sessionId: "session-b" },
			},
		},
	};
}

function presentation(
	overrides: Partial<ClientViewSyncSnapshot["presentation"]> = {},
) {
	return {
		selectedSessionId: "session-b",
		selectedSpaceId: "desktop-b",
		selectedPaneId: "term:b",
		layout: [
			{ paneId: "term:a", groupId: "left", order: 0, sizeBasisPoints: 6000 },
			{ paneId: "term:b", groupId: "right", order: 0, sizeBasisPoints: 4000 },
		],
		viewports: [],
		filters: [],
		subscriptions: [],
		...overrides,
	};
}

class FakeSync implements ClientViewStateSync {
	readonly update = vi.fn(() => true);
	readonly start = vi.fn(
		async () => ({ status: "synced", revision: 1 }) as const,
	);
	readonly flush = vi.fn(
		async () => ({ status: "synced", revision: 1 }) as const,
	);
	readonly retry = vi.fn(
		async () => ({ status: "synced", revision: 1 }) as const,
	);
	readonly resolveConflict = vi.fn(() => true);
	readonly shutdown = vi.fn(async () => ({ status: "closed" }) as const);
	private listeners = new Set<(snapshot: ClientViewSyncSnapshot) => void>();
	private snapshot: ClientViewSyncSnapshot;

	constructor(initial: ClientViewSyncSnapshot["presentation"]) {
		this.snapshot = {
			phase: "idle",
			presentation: initial,
			revision: 0,
			dirty: false,
			automaticRetryCount: 0,
		};
	}

	getSnapshot() {
		return this.snapshot;
	}

	subscribe(listener: (snapshot: ClientViewSyncSnapshot) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(snapshot: ClientViewSyncSnapshot) {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}

function fixture(
	clientId = "client-a",
	withDockview = false,
	initialPresentation?: ClientViewSyncSnapshot["presentation"],
) {
	let layoutInteractionActive = false;
	const dockviewToJSON = vi.fn(() => layout());
	const dockview = {
		activePanel: { id: "term:a" },
		toJSON: dockviewToJSON,
	};
	const state = {
		agents: [] as Agent[],
		spaces: [{ id: "desktop-a" }, { id: "desktop-b" }],
		activeSpaceId: "desktop-a",
		layouts: { "desktop-a": layout(), "desktop-b": layout() } as Record<
			string,
			unknown
		>,
		setActiveSpace: vi.fn((id: string) => {
			state.activeSpaceId = id;
			for (const listener of storeListeners) listener();
		}),
		saveLayout: (desktopId: string, value: unknown) => {
			state.layouts = { ...state.layouts, [desktopId]: value };
			for (const listener of storeListeners) listener();
		},
	};
	const storeListeners = new Set<() => void>();
	const registrationListeners = new Set<(desktopId: string) => void>();
	const publishLayoutPush = vi.fn();
	let options: ClientViewStateSyncOptions | undefined;
	let sync: FakeSync | undefined;
	const subscribeStore = vi.fn((listener: () => void) => {
		storeListeners.add(listener);
		return () => storeListeners.delete(listener);
	});
	const dependencies: ClientViewWorkspaceSyncDependencies = {
		identity: identity(clientId),
		viewId: `window:${clientId}`,
		transport: {} as ClientViewStateTransport,
		initialPresentation,
		getState: () => state,
		subscribeStore,
		dockviewFor: (desktopId) =>
			withDockview && desktopId === "desktop-a" ? dockview : undefined,
		mountedDockviews: () =>
			withDockview
				? ([["desktop-a", dockview]] as [string, typeof dockview][])
				: [],
		subscribeDockviewRegistration: (listener) => {
			registrationListeners.add(listener);
			return () => registrationListeners.delete(listener);
		},
		publishLayoutPush,
		isLayoutInteractionActive: () => layoutInteractionActive,
		createSync: (input) => {
			options = input;
			sync = new FakeSync(input.initialPresentation);
			return sync;
		},
	};
	const stop = createClientViewWorkspaceSyncRuntime(dependencies);
	return {
		get state() {
			return state;
		},
		options: () => options!,
		sync: () => sync!,
		publishLayoutPush,
		subscribeStore,
		setLayoutInteractionActive: (active: boolean) => {
			layoutInteractionActive = active;
		},
		dockviewToJSON,
		storeListeners,
		registrationListeners,
		stop,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Dure client view workspace sync", () => {
	it.each([
		{ paneId: "agent:agent-a", params: {} },
		{
			paneId: "agent:previous",
			params: { agentRef: { agentId: "agent-a" }, sessionId: "copied-session" },
		},
		{ paneId: "pane:opaque", params: { agentRef: { agentId: "agent-a" } } },
	])(
		"publishes the selected Agent's current runtime without changing $paneId",
		({ paneId, params }) => {
			const view = fixture("client-agent");
			const value = layout();
			value.grid.root.data[0].data.views = [paneId];
			value.grid.root.data[0].data.activeView = paneId;
			(
				value.panels as Record<
					string,
					{ contentComponent: string; params: Record<string, unknown> }
				>
			)[paneId] = { contentComponent: "agent", params };
			view.state.agents = [
				agentFixture({ id: "agent-a", sessionId: "session-agent-a" }),
			];
			view.sync().update.mockClear();

			view.state.saveLayout("desktop-a", value);

			expect(view.sync().update).toHaveBeenLastCalledWith(
				expect.objectContaining({
					selectedPaneId: paneId,
					selectedSessionId: "session-agent-a",
				}),
			);
			view.state.agents = [
				agentFixture({ id: "agent-a", sessionId: "successor-session" }),
			];
			view.state.saveLayout("desktop-a", value);
			expect(view.sync().update).toHaveBeenLastCalledWith(
				expect.objectContaining({
					selectedPaneId: paneId,
					selectedSessionId: "successor-session",
				}),
			);
			expect(view.state.layouts["desktop-a"]).toBe(value);
			view.stop();
		},
	);

	it("replays an explicit install baseline after subscribing and before start", () => {
		const unchanged = fixture("client-default");
		expect(unchanged.sync().update).not.toHaveBeenCalled();
		unchanged.stop();

		const replayed = fixture("client-install-order", false, presentation());
		expect(replayed.sync().update).toHaveBeenCalledOnce();
		expect(replayed.subscribeStore.mock.invocationCallOrder[0]).toBeLessThan(
			replayed.sync().update.mock.invocationCallOrder[0],
		);
		expect(replayed.sync().update.mock.invocationCallOrder[0]).toBeLessThan(
			replayed.sync().start.mock.invocationCallOrder[0],
		);
		replayed.stop();
	});

	it("keeps a space selected while local identity is still loading", async () => {
		vi.stubGlobal("location", { search: "" });
		vi.stubGlobal("document", {});
		const localIdentity = identity("client-bootstrap");
		let resolveIdentity: ((value: typeof localIdentity) => void) | undefined;
		const identityPending = new Promise<typeof localIdentity>((resolve) => {
			resolveIdentity = resolve;
		});
		installMocks.readIdentity.mockReturnValue(identityPending);

		const authority = {
			schemaVersion: 1 as const,
			namespace: localIdentity.namespace,
			clientGeneration: 1,
			clientInstanceId: localIdentity.clientInstanceId,
			updatedAtMs: 1,
		};
		const remotePresentation = presentation({
			selectedSessionId: null,
			selectedSpaceId: "desktop-a",
			selectedPaneId: null,
			layout: [],
		});
		let resolveView:
			| ((
					value: Awaited<ReturnType<ClientViewStateTransport["readView"]>>,
			  ) => void)
			| undefined;
		const viewPending = new Promise<
			Awaited<ReturnType<ClientViewStateTransport["readView"]>>
		>((resolve) => {
			resolveView = resolve;
		});
		const transport: ClientViewStateTransport = {
			readAuthority: vi.fn(async () => ({
				ok: true as const,
				value: authority,
			})),
			advanceGeneration: vi.fn(),
			readView: vi.fn(() => viewPending),
			writeView: vi.fn(),
		};
		installMocks.createTransport.mockReturnValue(transport);

		useStore.setState({
			spaces: [
				{ id: "desktop-a", name: "Space A" },
				{ id: "desktop-b", name: "Space B" },
			],
			activeSpaceId: "desktop-a",
			layouts: { "desktop-a": layout(), "desktop-b": layout() },
		});
		const installing = installDureClientViewWorkspaceSync();
		useStore.getState().setActiveSpace("desktop-b");
		expect(useStore.getState().activeSpaceId).toBe("desktop-b");
		resolveIdentity?.(localIdentity);

		let stop: (() => void) | undefined;
		try {
			stop = await installing;
			await vi.waitFor(() => expect(transport.readView).toHaveBeenCalledOnce());
			resolveView?.({
				ok: true,
				value: {
					schemaVersion: 1,
					identity: {
						namespace: localIdentity.namespace,
						clientGeneration: 1,
						clientInstanceId: localIdentity.clientInstanceId,
						viewId: "window:main",
					},
					revision: 7,
					presentation: remotePresentation,
					updatedAtMs: 7,
				},
			});
			await vi.waitFor(() =>
				expect(dureClientViewSyncHealth("window:main")).toMatchObject({
					phase: "ready",
					dirty: true,
					revision: 7,
				}),
			);

			expect(useStore.getState().activeSpaceId).toBe("desktop-b");
		} finally {
			stop?.();
			vi.unstubAllGlobals();
		}
	});

	it("consumes the final store layout without reserializing Dockview", () => {
		const view = fixture("client-drag", true);
		view.sync().update.mockClear();
		view.dockviewToJSON.mockClear();
		view.setLayoutInteractionActive(true);

		expect(view.dockviewToJSON).not.toHaveBeenCalled();
		expect(view.sync().update).not.toHaveBeenCalled();
		view.setLayoutInteractionActive(false);
		view.state.saveLayout("desktop-a", layout(349, 651));
		expect(view.dockviewToJSON).not.toHaveBeenCalled();
		expect(view.sync().update).toHaveBeenCalledOnce();
	});

	it("does not feed an optimistic local snapshot back through layout restore", () => {
		const view = fixture();
		const local = view.options().initialPresentation;
		view.sync().emit({
			phase: "ready",
			presentation: local,
			revision: 1,
			dirty: true,
			automaticRetryCount: 0,
		});

		expect(view.publishLayoutPush).not.toHaveBeenCalled();
	});

	it("keeps the live workspace authoritative during a sash interaction", () => {
		const view = fixture();
		view.setLayoutInteractionActive(true);

		view.sync().emit({
			phase: "ready",
			presentation: presentation(),
			revision: 7,
			dirty: false,
			automaticRetryCount: 0,
		});

		expect(view.state.activeSpaceId).toBe("desktop-a");
		expect(
			(
				view.state.layouts["desktop-a"] as {
					grid: { root: { data: { size: number }[] } };
				}
			).grid.root.data.map((node) => node.size),
		).toEqual([300, 700]);
		expect(view.publishLayoutPush).not.toHaveBeenCalled();
	});

	it("converges exact-topology geometry without changing local selection", () => {
		const view = fixture();
		view.sync().emit({
			phase: "ready",
			presentation: presentation(),
			revision: 7,
			dirty: false,
			automaticRetryCount: 0,
		});

		expect(view.state.activeSpaceId).toBe("desktop-a");
		expect(view.state.setActiveSpace).not.toHaveBeenCalled();
		expect(view.publishLayoutPush).toHaveBeenCalledWith(["desktop-b"]);
		expect(
			(
				view.state.layouts["desktop-b"] as {
					grid: { root: { data: { size: number }[] } };
				}
			).grid.root.data.map((node) => node.size),
		).toEqual([600, 400]);
		expect(
			(view.state.layouts["desktop-b"] as { activeGroup: string }).activeGroup,
		).toBe("left");
	});

	it("keeps local interaction nonblocking and separates offline health", () => {
		const view = fixture();
		view.sync().update.mockClear();
		view.state.setActiveSpace("desktop-b");
		expect(view.sync().update).toHaveBeenCalledOnce();

		view.sync().emit({
			phase: "offline",
			presentation: presentation(),
			revision: 2,
			dirty: true,
			automaticRetryCount: 3,
			lastError: { kind: "unavailable", message: "offline" },
		});
		expect(dureClientViewSyncHealth("window:client-a")).toMatchObject({
			phase: "offline",
			dirty: true,
			lastErrorKind: "unavailable",
		});
	});

	it("refuses unknown spaces and topology drift", () => {
		const view = fixture();
		view.sync().emit({
			phase: "ready",
			presentation: presentation({
				layout: [
					{
						paneId: "term:missing",
						groupId: "left",
						order: 0,
						sizeBasisPoints: 10_000,
					},
				],
			}),
			revision: 3,
			dirty: false,
			automaticRetryCount: 0,
		});
		expect(view.publishLayoutPush).not.toHaveBeenCalled();
		expect(view.state.activeSpaceId).toBe("desktop-a");

		view.sync().emit({
			phase: "ready",
			presentation: presentation({ selectedSpaceId: "desktop-missing" }),
			revision: 4,
			dirty: false,
			automaticRetryCount: 0,
		});
		expect(view.state.activeSpaceId).toBe("desktop-a");
	});

	it("preserves presentation fields that do not yet have a local UI owner", () => {
		const view = fixture();
		view.sync().emit({
			phase: "ready",
			presentation: presentation({
				viewports: [
					{ paneId: "term:b", anchorSequence: 42, scrollOffsetRows: -3 },
				],
				filters: [{ filterId: "working", enabled: true }],
				subscriptions: [{ topic: "session_output", resourceId: "session-b" }],
			}),
			revision: 4,
			dirty: false,
			automaticRetryCount: 0,
		});
		view.sync().update.mockClear();
		view.state.setActiveSpace("desktop-a");
		expect(view.sync().update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				viewports: [
					{ paneId: "term:b", anchorSequence: 42, scrollOffsetRows: -3 },
				],
				filters: [{ filterId: "working", enabled: true }],
				subscriptions: [{ topic: "session_output", resourceId: "session-b" }],
			}),
		);
	});

	it("preserves opaque fields even when no remote space is selected", () => {
		const view = fixture();
		view.sync().emit({
			phase: "ready",
			presentation: presentation({
				selectedSessionId: null,
				selectedSpaceId: null,
				selectedPaneId: null,
				filters: [{ filterId: "working", enabled: true }],
			}),
			revision: 5,
			dirty: false,
			automaticRetryCount: 0,
		});
		view.sync().update.mockClear();
		view.state.setActiveSpace("desktop-b");
		expect(view.sync().update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				filters: [{ filterId: "working", enabled: true }],
			}),
		);
	});

	it("keeps two client namespaces independent and cleans exact listeners", () => {
		const first = fixture("client-first");
		const second = fixture("client-second");
		expect(first.options().namespace.clientId).toBe("client-first");
		expect(second.options().namespace.clientId).toBe("client-second");
		expect(first.options().clientInstanceId).toBe("instance-client-first");
		expect(second.options().clientInstanceId).toBe("instance-client-second");

		first.stop();
		expect(first.storeListeners.size).toBe(0);
		expect(first.registrationListeners.size).toBe(0);
		expect(first.sync().shutdown).toHaveBeenCalledWith({ flush: false });
		expect(second.storeListeners.size).toBe(1);
		second.stop();
	});
});
