import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import type {
	TerminalPresentationRole,
	TerminalPresentationRoleStore,
} from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import { StructuredTerminalRecoveryAdmission } from "@/lib/terminal/structuredTerminalRecoveryAdmission";

export interface WorkspaceRuntimeTier {
	/** The desktop is the one on screen. */
	readonly active: boolean;
	/** Mounted-but-frozen shell tier: hidden and released from presentation. */
	readonly frozen: boolean;
}

export class WorkspaceRuntimeStore {
	private readonly listeners = new Set<() => void>();

	constructor(private tier: WorkspaceRuntimeTier) {}

	update(tier: WorkspaceRuntimeTier) {
		if (
			this.tier.active === tier.active &&
			this.tier.frozen === tier.frozen
		) {
			return;
		}
		this.tier = tier;
		for (const listener of this.listeners) listener();
	}

	read = () => this.tier.active;

	/**
	 * A warm (mounted, not frozen) desktop keeps its terminal presentations
	 * attached while hidden so activation reveals painted rows instead of a
	 * cold attach round trip. The frozen tier still releases them.
	 */
	readPresentationRetained = () => this.tier.active || !this.tier.frozen;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
}

interface WorkspaceRuntimeState {
	desktopId: string;
	runtime: WorkspaceRuntimeStore;
	presentationRoleStore: TerminalPresentationRoleStore;
	terminalRecoveryAdmission: StructuredTerminalRecoveryAdmission;
	commitLayout: () => boolean;
}

const WorkspaceRuntimeContext = createContext<
	WorkspaceRuntimeState | undefined
>(undefined);

export function WorkspaceRuntimeProvider({
	desktopId,
	active,
	frozen = false,
	presentationRoleStore,
	commitLayout,
	children,
}: {
	desktopId: string;
	active: boolean;
	frozen?: boolean;
	presentationRoleStore: TerminalPresentationRoleStore;
	commitLayout: () => boolean;
	children: ReactNode;
}) {
	const runtimeRef = useRef<WorkspaceRuntimeStore | null>(null);
	runtimeRef.current ??= new WorkspaceRuntimeStore({ active, frozen });
	const runtime = runtimeRef.current;
	const terminalRecoveryAdmissionRef =
		useRef<StructuredTerminalRecoveryAdmission | null>(null);
	terminalRecoveryAdmissionRef.current ??=
		new StructuredTerminalRecoveryAdmission();
	const terminalRecoveryAdmission = terminalRecoveryAdmissionRef.current;
	useLayoutEffect(
		() => runtime.update({ active, frozen }),
		[active, frozen, runtime],
	);
	const value = useMemo<WorkspaceRuntimeState>(
		() => ({
			desktopId,
			runtime,
			presentationRoleStore,
			terminalRecoveryAdmission,
			commitLayout,
		}),
		[
			desktopId,
			runtime,
			presentationRoleStore,
			terminalRecoveryAdmission,
			commitLayout,
		],
	);
	return (
		<WorkspaceRuntimeContext.Provider value={value}>
			{children}
		</WorkspaceRuntimeContext.Provider>
	);
}

export function useWorkspaceRuntimeDesktopId() {
	return useContext(WorkspaceRuntimeContext)?.desktopId;
}

export function useWorkspaceRuntimeActive() {
	const runtime = useContext(WorkspaceRuntimeContext)?.runtime;
	return useSyncExternalStore(
		runtime?.subscribe ?? subscribeDetached,
		runtime?.read ?? detachedActive,
		detachedActive,
	);
}

/** Whether a terminal presentation in this desktop stays mounted while hidden. */
export function useWorkspaceTerminalPresentationRetained() {
	const runtime = useContext(WorkspaceRuntimeContext)?.runtime;
	return useSyncExternalStore(
		runtime?.subscribe ?? subscribeDetached,
		runtime?.readPresentationRetained ?? detachedActive,
		detachedActive,
	);
}

export function useWorkspaceDurableLayoutCommit() {
	return useContext(WorkspaceRuntimeContext)?.commitLayout;
}

export function useWorkspaceTerminalRecoveryAdmission() {
	return useContext(WorkspaceRuntimeContext)?.terminalRecoveryAdmission;
}

const subscribeDetached = () => () => {};
const detachedActive = () => true;
const detachedRole = (): TerminalPresentationRole => "ungated";

/**
 * Foreground selection is a workspace-local external store. Keeping it out of the
 * Workspace React context prevents one pane click from rerendering every
 * mounted terminal in that workspace; only the old and new pane roles change.
 */
export function useWorkspaceTerminalPresentationRole(panelId?: string) {
	const store = useContext(WorkspaceRuntimeContext)?.presentationRoleStore;
	const subscribe = useCallback(
		(listener: () => void) =>
			store && panelId
				? store.subscribeRole(panelId, listener)
				: subscribeDetached(),
		[panelId, store],
	);
	return useSyncExternalStore(
		subscribe,
		store ? () => store.role(panelId) : detachedRole,
		detachedRole,
	);
}

/** Reports pointer presence to the workspace-local presentation priority store. */
export function useWorkspaceTerminalPresentationHover(panelId?: string) {
	const store = useContext(WorkspaceRuntimeContext)?.presentationRoleStore;
	const setHovered = useCallback(
		(hovered: boolean) => {
			if (store && panelId) store.setHovered(panelId, hovered);
		},
		[panelId, store],
	);
	useEffect(() => () => setHovered(false), [setHovered]);
	return setHovered;
}
