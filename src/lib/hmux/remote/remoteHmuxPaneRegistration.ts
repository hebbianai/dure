import type { GroupviewPanelState } from "dockview-react";
import {
	samePaneOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import {
	isTerminalPaneBindingV1,
	type RemoteHmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	appendPanelToLayout,
	isSerializedDockviewLayout,
	panelDefinitionFromLayout,
	panelIsPlacedInLayout,
	panelsFromLayout,
	type SerializedPanelRef,
} from "@/lib/workspace/layout/layoutLifecycle";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
} from "@/store";
import type { SshHostConfig } from "@/types";

interface RemoteHmuxPaneRegistrationState {
	readonly sshHosts: readonly SshHostConfig[];
	readonly spaces: readonly { readonly id: string }[];
	readonly layouts: Readonly<Record<string, unknown>>;
}

/** The Dockview `panels` entry the registration writes: Dockview's own
 * serialized panel shape, with the terminal view named. */
interface RemoteHmuxPaneDefinition extends Readonly<GroupviewPanelState> {
	readonly id: string;
	readonly contentComponent: "terminal";
	readonly title: string;
	readonly params: Readonly<Record<string, unknown>>;
}

export interface RemoteHmuxPaneRegistration {
	readonly host: SshHostConfig;
	readonly spaceId: string;
	readonly panelId: string;
	readonly binding: RemoteHmuxStandalonePaneBindingV1;
	readonly definition: RemoteHmuxPaneDefinition;
	readonly fallbackLayout: unknown;
	readonly position?: PanelPosition;
	/** Captured content and its live view capability, never persisted as runtime state. */
	readonly replacement?: {
		readonly pane: SerializedPanelRef;
		readonly isCurrent: () => boolean;
	};
}

function sameDefinition(left: unknown, right: unknown): boolean {
	return samePaneOperationalIdentity(left, right);
}

function sameBinding(
	value: unknown,
	expected: RemoteHmuxStandalonePaneBindingV1,
): boolean {
	return (
		isTerminalPaneBindingV1(value) &&
		value.runtime === "hmux_standalone_v1" &&
		value.source === "ssh" &&
		value.hostId === expected.hostId &&
		value.sessionId === expected.sessionId &&
		value.workspaceId === expected.workspaceId &&
		value.commandBridgeNonce === expected.commandBridgeNonce
	);
}

function registrationLayout(
	registration: RemoteHmuxPaneRegistration,
	state: RemoteHmuxPaneRegistrationState,
): unknown | undefined {
	const currentHost = state.sshHosts.find(
		(host) => host.id === registration.host.id,
	);
	if (
		!sameSshHostOperationalIdentity(currentHost, registration.host) ||
		!state.spaces.some((space) => space.id === registration.spaceId)
	) {
		return undefined;
	}
	const layout =
		state.layouts[registration.spaceId] ?? registration.fallbackLayout;
	return isSerializedDockviewLayout(layout) ? layout : undefined;
}

/** Whether the exact Host-owned pane registration is still authoritative. */
export function remoteHmuxPaneRegistrationApplies(
	registration: RemoteHmuxPaneRegistration,
	state: RemoteHmuxPaneRegistrationState,
): boolean {
	const layout = registrationLayout(registration, state);
	if (!layout) return false;
	const existing = panelDefinitionFromLayout(layout, registration.panelId);
	return (
		existing !== undefined &&
		sameDefinition(existing, registration.definition) &&
		panelIsPlacedInLayout(layout, registration.panelId)
	);
}

/** Whether Dockview mounted the exact durable pane generation. */
export function remoteHmuxMountedPaneApplies(
	registration: RemoteHmuxPaneRegistration,
	panel: { readonly params?: unknown } | undefined,
): boolean {
	const params = panel?.params;
	if (params === null || typeof params !== "object") return false;
	return (
		samePaneOperationalIdentity(params, registration.definition.params) &&
		sameBinding(
			(params as Readonly<Record<string, unknown>>).binding,
			registration.binding,
		)
	);
}

/** Linearize one Host-owned pane with Host removal before exposing it. */
export function registerRemoteHmuxPaneDurably(
	registration: RemoteHmuxPaneRegistration,
): Promise<boolean> {
	return durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
		if (!current) return { value: current, result: false };
		const state = normalizePersistedState(current.state);
		const layout = registrationLayout(registration, state);
		if (!layout) return { value: current, result: false };
		const existing = panelDefinitionFromLayout(layout, registration.panelId);
		let nextLayout: unknown;
		if (existing !== undefined) {
			if (!panelIsPlacedInLayout(layout, registration.panelId))
				return { value: current, result: false };
			if (sameDefinition(existing, registration.definition))
				return { value: current, result: true };
			const replacement = registration.replacement;
			const currentPane = panelsFromLayout(layout).find(
				(pane) => pane.id === registration.panelId,
			);
			if (
				!replacement?.isCurrent() ||
				!samePaneOperationalIdentity(currentPane, replacement.pane)
			)
				return { value: current, result: false };
			const placedLayout = layout as { panels: Record<string, unknown> };
			nextLayout = {
				...placedLayout,
				panels: {
					...placedLayout.panels,
					[registration.panelId]: registration.definition,
				},
			};
		} else {
			if (registration.replacement) return { value: current, result: false };
			nextLayout = appendPanelToLayout(
				layout,
				registration.panelId,
				registration.definition,
				registration.position,
			);
		}
		if (!nextLayout) return { value: current, result: false };

		return {
			value: {
				version: PERSIST_VERSION,
				state: persistedSlice({
					...state,
					layouts: {
						...state.layouts,
						[registration.spaceId]: nextLayout,
					},
				}),
			},
			result: true,
		};
	});
}

/** Read whether durable state still places this exact Host-owned pane generation. */
export function hasDurableRemoteHmuxPaneReference(
	registration: RemoteHmuxPaneRegistration,
): Promise<boolean> {
	return durableAppStorage.read(DURABLE_APP_STORE_NAME, (current) => {
		if (!current) return false;
		const state = normalizePersistedState(current.state);
		const currentHost = state.sshHosts.find(
			(host) => host.id === registration.host.id,
		);
		const spaces = new Set(state.spaces.map((space) => space.id));
		const referenced =
			sameSshHostOperationalIdentity(currentHost, registration.host) &&
			Object.entries(state.layouts).some(([spaceId, layout]) => {
				if (
					!spaces.has(spaceId) ||
					!panelIsPlacedInLayout(layout, registration.panelId)
				) {
					return false;
				}
				const definition = panelDefinitionFromLayout(
					layout,
					registration.panelId,
				);
				const params =
					definition && typeof definition === "object"
						? (definition as Readonly<Record<string, unknown>>).params
						: undefined;
				return (
					params !== null &&
					typeof params === "object" &&
					sameBinding(
						(params as Readonly<Record<string, unknown>>).binding,
						registration.binding,
					)
				);
			});
		return referenced;
	});
}
