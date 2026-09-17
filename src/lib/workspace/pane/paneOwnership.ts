import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";

export interface PaneOwner {
	readonly desktopId: string;
	readonly panelId: string;
}

export function paneAgentId(owner: PaneOwner): string | undefined {
	const api = getDockview(owner.desktopId);
	const mounted = api?.getPanel(owner.panelId);
	// A mounted Space owns its current content, including an absent pane.
	const pane = api
		? mounted && dockPanelReference(mounted)
		: panelsFromLayout(useStore.getState().layouts[owner.desktopId]).find(
				(panel) => panel.id === owner.panelId,
			);
	return pane?.component === "agent"
		? agentIdFromPaneParameters(pane.params)
		: undefined;
}

/** Confirms that the current durable layout still assigns a pane to a desktop. */
export function isDurablePaneOwned(owner: PaneOwner): boolean {
	const state = useStore.getState();
	return (
		state.spaces.some((desktop) => desktop.id === owner.desktopId) &&
		panelsFromLayout(state.layouts[owner.desktopId]).some(
			(panel) => panel.id === owner.panelId,
		)
	);
}

/** Confirms that the durable pane is also present in its mounted Dockview. */
export function isMountedPaneOwned(owner: PaneOwner): boolean {
	return (
		isDurablePaneOwned(owner) &&
		Boolean(getDockview(owner.desktopId)?.getPanel(owner.panelId))
	);
}
