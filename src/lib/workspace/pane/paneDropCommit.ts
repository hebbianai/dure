import type {
	DesktopPaneMoveItem,
	MovePanelsToDesktopReceipt,
} from "@/lib/workspace/desktop/desktopPaneMove";
import {
	dockviewRegistry,
	movingPanels,
} from "@/lib/workspace/dock/dockRegistry";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import { useStore } from "@/store";
import { commitPaneDropTransaction } from "./paneDropTransaction";
import type { PanelPosition } from "./panePlacement";
import { retargetMovedHiddenPanes } from "./paneVisibility";

/** Execute the established target-owned drop while its caller owns sequencing. */
export function commitDesktopPaneDrop(
	item: DesktopPaneMoveItem,
	targetDesktopId: string,
	position: PanelPosition,
): MovePanelsToDesktopReceipt {
	const receipt = commitPaneDropTransaction(item, targetDesktopId, position, {
		liveDockviews: dockviewRegistry,
		readLayouts: () => useStore.getState().layouts,
		writeLayouts: (layouts) => useStore.setState({ layouts }),
		guardPanelMove: (panelId) => {
			movingPanels.add(panelId);
			return () => {
				// Dockview can report the provisional target or committed
				// source removal at the end of the current task.
				setTimeout(() => movingPanels.delete(panelId), 0);
			};
		},
		publishLayoutPush,
	});
	return retargetMovedHiddenPanes(
		receipt,
		targetDesktopId,
		useStore.getState().layouts[targetDesktopId],
	);
}
