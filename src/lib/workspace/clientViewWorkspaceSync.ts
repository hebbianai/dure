import type { DockviewApi } from "dockview-react";
import { createDureClientViewStateTransport } from "@/lib/ipc/dureClientView";
import {
	type DureClientViewLocalIdentityV1,
	readDureClientViewLocalIdentity,
} from "@/lib/ipc/dureClientViewIdentity";
import { isSashDragActive } from "@/lib/ui/sashDragHighlight";
import {
	applyClientViewLayout,
	projectClientViewLayout,
	selectedPaneFromLayout,
	sessionIdForClientViewPane,
	validClientViewToken,
} from "@/lib/workspace/clientViewLayout";
import {
	type ClientViewPresentationV1,
	type ClientViewStateTransport,
	clientViewPresentationsEqual,
} from "@/lib/workspace/clientViewState";
import {
	type ClientViewStateSync,
	type ClientViewSyncPhase,
	type ClientViewSyncSnapshot,
	createClientViewStateSync,
} from "@/lib/workspace/clientViewStateSync";
import {
	dockviewRegistry,
	mountedDockviewEntries,
} from "@/lib/workspace/dock/dockRegistry";
import { subscribeDockviewRegistration } from "@/lib/workspace/dock/dockviewRegistration";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import { initialDesktopId } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import type { Agent } from "@/types";

interface ClientViewWorkspaceState {
	agents: readonly Agent[];
	spaces: readonly { id: string }[];
	activeSpaceId: string;
	layouts: Readonly<Record<string, unknown>>;
	saveLayout(desktopId: string, layout: unknown): void;
}

interface DockviewSubscription {
	dispose(): void;
}

interface ClientViewDockview {
	activePanel?: { id: string; params?: unknown };
	onDidActivePanelChange?(listener: () => void): DockviewSubscription;
}

export interface DureClientViewSyncHealth {
	viewId: string;
	phase: ClientViewSyncPhase;
	dirty: boolean;
	revision: number;
	lastErrorKind?: string;
	conflictingFields: string[];
}

const healthByView = new Map<string, DureClientViewSyncHealth>();

function publishHealth(viewId: string, snapshot: ClientViewSyncSnapshot): void {
	healthByView.set(viewId, {
		viewId,
		phase: snapshot.phase,
		dirty: snapshot.dirty,
		revision: snapshot.revision,
		lastErrorKind: snapshot.lastError?.kind,
		conflictingFields: snapshot.conflict?.fields ?? [],
	});
}

export function dureClientViewSyncHealth(
	viewId: string,
): DureClientViewSyncHealth | undefined {
	const health = healthByView.get(viewId);
	return health
		? { ...health, conflictingFields: [...health.conflictingFields] }
		: undefined;
}

export interface ClientViewWorkspaceSyncDependencies {
	identity: DureClientViewLocalIdentityV1;
	viewId: string;
	transport: ClientViewStateTransport;
	initialPresentation?: ClientViewPresentationV1;
	getState(): ClientViewWorkspaceState;
	subscribeStore(listener: () => void): () => void;
	dockviewFor(desktopId: string): ClientViewDockview | undefined;
	mountedDockviews(): readonly [string, ClientViewDockview][];
	subscribeDockviewRegistration(
		listener: (desktopId: string) => void,
	): () => void;
	publishLayoutPush(desktopIds: readonly string[]): void;
	isLayoutInteractionActive(): boolean;
	createSync?: typeof createClientViewStateSync;
}

function currentPresentation(
	state: ClientViewWorkspaceState,
	dockview: ClientViewDockview | undefined,
): ClientViewPresentationV1 {
	const selectedSpaceId = state.spaces.some(
		(desktop) => desktop.id === state.activeSpaceId,
	)
		? state.activeSpaceId
		: null;
	const layout = state.layouts[state.activeSpaceId];
	const observedPaneId =
		dockview?.activePanel?.id ?? selectedPaneFromLayout(layout);
	const selectedPaneId = validClientViewToken(observedPaneId)
		? observedPaneId
		: null;
	return {
		selectedSessionId: sessionIdForClientViewPane(
			layout,
			selectedPaneId,
			state.agents,
		),
		selectedSpaceId,
		selectedPaneId,
		layout: projectClientViewLayout(layout),
		viewports: [],
		filters: [],
		subscriptions: [],
	};
}

function viewIdIsValid(viewId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(viewId);
}

/**
 * Bridge the optimistic controller to one Dure window's actual workspace.
 * Local UI changes never await this runtime; backend health is published on a
 * separate observable and cannot alter Hmux pane connection dots.
 */
export function createClientViewWorkspaceSyncRuntime(
	dependencies: ClientViewWorkspaceSyncDependencies,
): () => void {
	if (!viewIdIsValid(dependencies.viewId)) {
		throw new Error("Dure client view id is invalid");
	}
	let disposed = false;
	let applyingRemote = false;
	let retainedViewports: ClientViewPresentationV1["viewports"] = [];
	let retainedFilters: ClientViewPresentationV1["filters"] = [];
	let retainedSubscriptions: ClientViewPresentationV1["subscriptions"] = [];
	const dockviewSubscriptions = new Map<
		string,
		{ dockview: ClientViewDockview; stop: () => void }
	>();

	const readLocal = () => {
		const state = dependencies.getState();
		const presentation = currentPresentation(
			state,
			dependencies.dockviewFor(state.activeSpaceId),
		);
		return {
			...presentation,
			viewports: retainedViewports.map((viewport) => ({ ...viewport })),
			filters: retainedFilters.map((filter) => ({ ...filter })),
			subscriptions: retainedSubscriptions.map((subscription) => ({
				...subscription,
			})),
		};
	};
	const createSync = dependencies.createSync ?? createClientViewStateSync;
	const sync: ClientViewStateSync = createSync({
		namespace: dependencies.identity.namespace,
		viewId: dependencies.viewId,
		clientInstanceId: dependencies.identity.clientInstanceId,
		initialPresentation: dependencies.initialPresentation ?? readLocal(),
		transport: dependencies.transport,
	});

	const reconcilePresentation = (presentation: ClientViewPresentationV1) => {
		if (disposed || applyingRemote) return;
		retainedViewports = presentation.viewports.map((viewport) => ({
			...viewport,
		}));
		retainedFilters = presentation.filters.map((filter) => ({ ...filter }));
		retainedSubscriptions = presentation.subscriptions.map((subscription) => ({
			...subscription,
		}));
		if (dependencies.isLayoutInteractionActive()) return;
		// Sync emits optimistic local snapshots as well as remote ones. Dockview
		// already owns an equal local snapshot; restoring it would feed selection
		// back through fromJSON and rebuild every pane on each focus change.
		if (clientViewPresentationsEqual(presentation, readLocal())) return;
		if (!presentation.selectedSpaceId) return;
		const before = dependencies.getState();
		// The persisted selection locates its geometry snapshot; this window alone
		// owns which Space and pane are visible.
		const desktopId = presentation.selectedSpaceId;
		if (!before.spaces.some((desktop) => desktop.id === desktopId)) return;
		const layout = before.layouts[desktopId];
		applyingRemote = true;
		try {
			const applied = applyClientViewLayout(layout, presentation.layout);
			if (applied.status === "applied") {
				dependencies.getState().saveLayout(desktopId, applied.layout);
				dependencies.publishLayoutPush([desktopId]);
			}
		} finally {
			applyingRemote = false;
		}
	};

	const stopSnapshot = sync.subscribe((snapshot) => {
		publishHealth(dependencies.viewId, snapshot);
		if (
			snapshot.phase !== "conflict" &&
			snapshot.phase !== "fenced" &&
			snapshot.phase !== "fatal" &&
			snapshot.phase !== "closed"
		) {
			reconcilePresentation(snapshot.presentation);
		}
	});

	const updateFromLocal = () => {
		if (!disposed && !applyingRemote) sync.update(readLocal());
	};
	const attachDockview = (desktopId: string) => {
		const dockview = dependencies.dockviewFor(desktopId);
		const existing = dockviewSubscriptions.get(desktopId);
		if (!dockview || existing?.dockview === dockview) return;
		existing?.stop();
		const activePanelSubscription =
			dockview.onDidActivePanelChange?.(updateFromLocal);
		dockviewSubscriptions.set(desktopId, {
			dockview,
			stop: () => activePanelSubscription?.dispose(),
		});
		updateFromLocal();
	};
	for (const [desktopId] of dependencies.mountedDockviews()) {
		attachDockview(desktopId);
	}
	const stopDockviewRegistration =
		dependencies.subscribeDockviewRegistration(attachDockview);
	// Subscribe before the post-identity sample: a synchronous Zustand mutation
	// during installation is either delivered to updateFromLocal or observed by
	// this read, so there is no unobserved handoff gap.
	const stopStore = dependencies.subscribeStore(updateFromLocal);
	const current = readLocal();
	if (!clientViewPresentationsEqual(current, sync.getSnapshot().presentation)) {
		sync.update(current);
	}
	// Keep start in this synchronous task. Any pre-start local drift is now dirty
	// and therefore enters the controller's existing three-way merge path.
	void sync.start();

	return () => {
		if (disposed) return;
		disposed = true;
		stopStore();
		stopDockviewRegistration();
		stopSnapshot();
		for (const subscription of dockviewSubscriptions.values()) {
			subscription.stop();
		}
		dockviewSubscriptions.clear();
		healthByView.set(dependencies.viewId, {
			viewId: dependencies.viewId,
			phase: "closed",
			dirty: sync.getSnapshot().dirty,
			revision: sync.getSnapshot().revision,
			conflictingFields: [],
		});
		void sync.shutdown({ flush: false });
	};
}

const activeInstallations = new Map<string, () => void>();
const installationRequests = new Map<string, number>();

function currentWindowViewId(): string {
	const desktopId = initialDesktopId();
	return desktopId ? `window:${desktopId}` : "window:main";
}

export async function installDureClientViewWorkspaceSync(
	options: { profileId?: string } = {},
): Promise<() => void> {
	const viewId = currentWindowViewId();
	const request = (installationRequests.get(viewId) ?? 0) + 1;
	installationRequests.set(viewId, request);
	const initialState = useStore.getState();
	const initialPresentation = currentPresentation(
		initialState,
		dockviewRegistry.get(initialState.activeSpaceId),
	);
	const identity = await readDureClientViewLocalIdentity();
	if (installationRequests.get(viewId) !== request) return () => {};
	activeInstallations.get(viewId)?.();
	const stop = createClientViewWorkspaceSyncRuntime({
		identity,
		viewId,
		initialPresentation,
		transport: createDureClientViewStateTransport({
			profileId: options.profileId,
		}),
		getState: () => useStore.getState(),
		subscribeStore: (listener) =>
			useStore.subscribe((state, previous) => {
				if (
					state.activeSpaceId !== previous.activeSpaceId ||
					state.spaces !== previous.spaces ||
					state.layouts !== previous.layouts
				) {
					listener();
				}
			}),
		dockviewFor: (desktopId) => dockviewRegistry.get(desktopId),
		mountedDockviews: () =>
			mountedDockviewEntries() as readonly [string, DockviewApi][],
		subscribeDockviewRegistration,
		publishLayoutPush: (desktopIds) =>
			publishLayoutPush(desktopIds, { localDelivery: true }),
		isLayoutInteractionActive: () => isSashDragActive(document),
	});
	activeInstallations.set(viewId, stop);
	return () => {
		if (activeInstallations.get(viewId) !== stop) return;
		activeInstallations.delete(viewId);
		stop();
	};
}
