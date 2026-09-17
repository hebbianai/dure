import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { isDurablePaneOwned } from "@/lib/workspace/pane/paneOwnership";
import { restorePanePreservingLayout } from "@/lib/workspace/pane/paneVisibility";
import { useStore } from "@/store";
import type { LargeViewSourcePaneTarget } from "./largeViewReturnSourceCoordinator";

/** Activates one exact source pane after confirming its current ownership. */
export function activateLargeViewSourcePane(
	target: LargeViewSourcePaneTarget,
): boolean {
	if (!isDurablePaneOwned(target)) {
		return false;
	}

	const state = useStore.getState();
	const dockview = getDockview(target.desktopId);
	if (dockview && !dockview.getPanel(target.panelId)) return false;

	const alreadyActive = state.activeSpaceId === target.desktopId;
	navigateToPanel(target.desktopId, target.panelId);
	if (!alreadyActive && dockview) {
		restorePanePreservingLayout(dockview, target.panelId);
	}
	return true;
}
